import { gainAt, sourcePosition } from "./segment";
import type { Segment } from "./segment";

/** Samples per PCM chunk: 5.5 s, 512 KB. */
export const CHUNK_SAMPLES = 1 << 18;
/** A grain: 40 ms at 48 kHz. Grains overlap by half, so two always sound. */
export const GRAIN = 1920;
const HOP = GRAIN / 2;
/** Clips that sound at once; the rest under the playhead stay silent. */
const MAX_VOICES = 16;
/** Starting, stopping, and moving from one motion to the next all take 5 ms. */
export const FADE = 240;
/** A tape voice that reaches a chunk not yet held fades to silence over 1 ms, and back. */
const GATE = 48;

// A periodic Hann window: two of them half a grain apart sum to exactly one.
const window = Float32Array.from(
  { length: GRAIN },
  (_, j) => 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / GRAIN),
);

/**
 * Where the sound is: at audio frame `frame` it reads output sample `position`, and it moves
 * `velocity` output samples per audio frame, negative in reverse.
 */
export type Motion = { frame: number; position: number; velocity: number };

/** A segment with the chunks of its source the audio thread holds, by chunk index. */
export type Voice = {
  segment: Segment;
  chunks: ReadonlyMap<number, Int16Array>;
};

/** What the last block read: its peak level, and the last source sample a voice read. */
export type Reading = { peak: number; source: number | null };

const chunkOf = (k: number) => Math.floor(k / CHUNK_SAMPLES);
const held = (chunks: Voice["chunks"], k: number) => chunks.has(chunkOf(k));

function sample(chunks: Voice["chunks"], k: number) {
  const index = chunkOf(k);
  return (chunks.get(index)?.[k - index * CHUNK_SAMPLES] ?? 0) / 32768;
}

/** The source sample at a fractional index, straight between neighbours. */
function read(chunks: Voice["chunks"], at: number) {
  const index = Math.floor(at);
  const fraction = at - index;
  const a = sample(chunks, index);
  return fraction ? a + (sample(chunks, index + 1) - a) * fraction : a;
}

/** One motion's reading of the voices, with each tape voice's gate. */
class Lane {
  motion: Motion | null = null;
  gates = new Float32Array(0);
  last = new Float32Array(0);
  sounding = new Int32Array(MAX_VOICES);

  start(motion: Motion, voices: number) {
    this.motion = motion;
    if (this.gates.length !== voices) {
      this.gates = new Float32Array(voices);
      this.last = new Float32Array(voices);
    }
    this.gates.fill(1);
    this.last.fill(0);
  }

  /**
   * Up to 1x either way it is a tape: every output sample reads the next position, so pitch
   * follows speed and reverse is the forward sound backwards. Faster, it overlap-adds 40 ms
   * grains, each starting where the motion has reached and reading one source sample per output
   * sample, so they keep the source's own pitch even on a clip at another speed. A grain whose
   * source is not all held stays silent for its whole length.
   */
  render(
    out: Float32Array,
    frame: number,
    voices: readonly Voice[],
    reading: Reading,
  ) {
    const { position, velocity } = this.motion!;
    const start = position + (frame - this.motion!.frame) * velocity;
    const grains = Math.abs(velocity) > 1;
    const reach = grains ? GRAIN * (1 + Math.abs(velocity)) : 1;
    const end = start + out.length * velocity;
    const low = Math.min(start, end) - reach;
    const high = Math.max(start, end) + reach;
    let count = 0;
    for (let v = 0; v < voices.length && count < MAX_VOICES; v++) {
      const { samples } = voices[v]!.segment;
      if (samples.start <= high && samples.end > low)
        this.sounding[count++] = v;
    }
    out.fill(0);
    if (!count) return;

    const direction = Math.sign(velocity);
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      if (!grains) {
        const n = start + i * velocity;
        for (let c = 0; c < count; c++) {
          const v = this.sounding[c]!;
          const { segment, chunks } = voices[v]!;
          if (n < segment.samples.start || n >= segment.samples.end) continue;
          const source = sourcePosition(segment, n);
          const at = Math.floor(source);
          let value: number;
          if (held(chunks, at) && held(chunks, at + 1)) {
            value = read(chunks, source);
            this.gates[v] = Math.min(1, this.gates[v]! + 1 / GATE);
            this.last[v] = value;
          } else {
            value = this.last[v]!;
            this.gates[v] = Math.max(0, this.gates[v]! - 1 / GATE);
          }
          reading.source = at;
          sum += value * this.gates[v]! * gainAt(segment.gain, n);
        }
      } else {
        const t = frame + i - this.motion!.frame;
        const k = Math.floor(t / HOP);
        const j = t - k * HOP;
        // The grain that began this hop, and the one before it, half a grain in.
        const anchor = position + k * HOP * velocity;
        for (let c = 0; c < count; c++) {
          const voice = voices[this.sounding[c]!]!;
          sum +=
            grain(voice, anchor, j, direction, reading) +
            grain(voice, anchor - HOP * velocity, j + HOP, direction, reading);
        }
      }
      out[i] = sum;
    }
  }
}

/** A grain anchored at output sample `anchor`, `phase` samples in. */
function grain(
  { segment, chunks }: Voice,
  anchor: number,
  phase: number,
  direction: number,
  reading: Reading,
) {
  const n = anchor + direction * phase;
  if (n < segment.samples.start || n >= segment.samples.end) return 0;
  const first = sourcePosition(segment, anchor);
  const last = first + direction * GRAIN;
  if (!held(chunks, first) || !held(chunks, last)) return 0;
  const source = first + direction * phase;
  reading.source = Math.floor(source);
  return window[phase]! * read(chunks, source) * gainAt(segment.gain, n);
}

/**
 * Plays motions over a set of voices. A new motion while sound plays crosses over from the old
 * one in 5 ms; starting and stopping fade in and out over the same. Everything it renders into
 * is allocated up front, so a block allocates nothing.
 */
export class Player {
  voices: readonly Voice[] = [];
  readonly reading: Reading = { peak: 0, source: null };
  private current = new Lane();
  private previous = new Lane();
  private mix = 1;
  private level = 0;
  private target = 0;
  private now = new Float32Array(128);
  private then = new Float32Array(128);

  setVoices(voices: readonly Voice[]) {
    this.voices = voices;
    for (const lane of [this.current, this.previous])
      if (lane.motion) lane.start(lane.motion, voices.length);
  }

  run(motion: Motion) {
    if (this.current.motion && this.level > 0) {
      // A motion arriving mid-crossover drops the oldest one; motions come a frame apart at most.
      [this.previous, this.current] = [this.current, this.previous];
      this.mix = 0;
    }
    this.current.start(motion, this.voices.length);
    this.target = 1;
  }

  stop() {
    this.target = 0;
  }

  /** Renders one block. False when idle, which leaves `out` untouched. */
  process(out: Float32Array, frame: number) {
    if (!this.current.motion) return false;
    if (this.now.length !== out.length) {
      this.now = new Float32Array(out.length);
      this.then = new Float32Array(out.length);
    }
    const crossing = this.previous.motion !== null;
    if (crossing)
      this.previous.render(this.then, frame, this.voices, this.reading);
    this.current.render(this.now, frame, this.voices, this.reading);
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      let value = this.now[i]!;
      if (crossing) {
        this.mix = Math.min(1, this.mix + 1 / FADE);
        value = this.then[i]! + (value - this.then[i]!) * this.mix;
      }
      if (this.level !== this.target)
        this.level =
          this.target > this.level
            ? Math.min(this.target, this.level + 1 / FADE)
            : Math.max(this.target, this.level - 1 / FADE);
      out[i] = value * this.level;
      peak = Math.max(peak, Math.abs(out[i]!));
    }
    if (this.mix === 1) this.previous.motion = null;
    if (!this.level && !this.target) {
      this.current.motion = null;
      this.previous.motion = null;
    }
    this.reading.peak = peak;
    return true;
  }
}
