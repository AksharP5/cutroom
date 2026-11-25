import {
  gainAt,
  sourcePosition,
  unwrappedSourcePosition,
  wrapPosition,
} from "./segment";
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

/**
 * What the player read: the last block's peak, the last source sample a voice read, and the
 * lowest and highest since whoever reads them last reset them.
 */
export type Reading = {
  peak: number;
  source: number | null;
  low: number;
  high: number;
};

function note(reading: Reading, at: number) {
  reading.source = at;
  if (at < reading.low) reading.low = at;
  if (at > reading.high) reading.high = at;
}

/**
 * Where a dragged playhead is: output sample `position` at audio frame `frame`, moving
 * `velocity` samples per frame. Once `rest` frames pass with no newer report, it has stopped.
 */
export type Chase = {
  frame: number;
  position: number;
  velocity: number;
  rest: number;
};
/** A drag's sound catches up with the pointer over 10 ms. */
const LAG = 480;
/** The fastest a drag plays, as tape; a pointer further ahead than JUMP is jumped to. */
const MAX_CHASE = 8;
const JUMP = 9600;
/** A frame step's blip fades in and out over 1 ms. */
const EDGE = 48;

const chunkOf = (k: number) => Math.floor(k / CHUNK_SAMPLES);
const held = (chunks: Voice["chunks"], k: number) => chunks.has(chunkOf(k));

function sample(chunks: Voice["chunks"], k: number) {
  const index = chunkOf(k);
  return (chunks.get(index)?.[k - index * CHUNK_SAMPLES] ?? 0) / 32768;
}

/** The source sample at a fractional index, straight between neighbours. */
function read(
  chunks: Voice["chunks"],
  at: number,
  index: number,
  next: number,
) {
  const fraction = at - index;
  const a = sample(chunks, index);
  return fraction ? a + (sample(chunks, next) - a) * fraction : a;
}

/** One motion's reading of the voices, with each tape voice's gate. */
class Lane {
  motion: Motion | null = null;
  /** Read as tape at any speed: a drag, or a frame step. */
  tape = false;
  /** Output samples outside this window stay silent: a frame step plays only its frame. */
  limit: { start: number; end: number } | null = null;
  gates = new Float32Array(0);
  last = new Float32Array(0);
  sounding = new Int32Array(MAX_VOICES);

  start(
    motion: Motion,
    voices: number,
    tape = false,
    limit: Lane["limit"] = null,
  ) {
    this.motion = motion;
    this.tape = tape;
    this.limit = limit;
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
    const grains = !this.tape && Math.abs(velocity) > 1;
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
        if (this.limit && (n < this.limit.start || n >= this.limit.end)) {
          out[i] = 0;
          continue;
        }
        for (let c = 0; c < count; c++) {
          const v = this.sounding[c]!;
          const { segment, chunks } = voices[v]!;
          if (n < segment.samples.start || n >= segment.samples.end) continue;
          const source = sourcePosition(segment, n);
          const at = Math.floor(source);
          const next = segment.loop
            ? Math.floor(wrapPosition(segment.loop, Math.ceil(source)))
            : at + 1;
          let value: number;
          if (held(chunks, at) && held(chunks, next)) {
            value = read(chunks, source, at, next);
            this.gates[v] = Math.min(1, this.gates[v]! + 1 / GATE);
            this.last[v] = value;
          } else {
            value = this.last[v]!;
            this.gates[v] = Math.max(0, this.gates[v]! - 1 / GATE);
          }
          note(reading, at);
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
  const first = unwrappedSourcePosition(segment, anchor);
  const { loop } = segment;
  const last = wrapPosition(loop, first + direction * GRAIN);
  if (!held(chunks, wrapPosition(loop, first)) || !held(chunks, last)) return 0;
  const source = wrapPosition(loop, first + direction * phase);
  const at = Math.floor(source);
  const next = loop
    ? Math.floor(wrapPosition(loop, Math.ceil(source)))
    : at + 1;
  if (loop && (!held(chunks, at) || !held(chunks, next))) return 0;
  note(reading, at);
  return (
    window[phase]! * read(chunks, source, at, next) * gainAt(segment.gain, n)
  );
}

/**
 * Plays motions over a set of voices: a shuttle's steady motion, a drag that follows the
 * pointer, or one frame's blip. A new one while sound plays crosses over from the old one in
 * 5 ms; starting and stopping fade in and out over the same. Everything it renders into is
 * allocated up front, so a block allocates nothing.
 */
export class Player {
  voices: readonly Voice[] = [];
  readonly reading: Reading = {
    peak: 0,
    source: null,
    low: Infinity,
    high: -Infinity,
  };
  private current = new Lane();
  private previous = new Lane();
  private mix = 1;
  private level = 0;
  private target = 0;
  /** How far the level moves per sample: 5 ms fades, or 1 ms for a blip. */
  private step = 1 / FADE;
  /** The audio frame a blip starts fading out at. */
  private endAt = Infinity;
  private chasing: { report: Chase; received: number; motion: Motion } | null =
    null;
  private now = new Float32Array(128);
  private then = new Float32Array(128);

  setVoices(voices: readonly Voice[]) {
    this.voices = voices;
    for (const lane of [this.current, this.previous])
      if (lane.motion)
        lane.start(lane.motion, voices.length, lane.tape, lane.limit);
  }

  private begin(motion: Motion, tape: boolean, limit: Lane["limit"] = null) {
    if (this.current.motion && this.level > 0) {
      // A motion arriving mid-crossover drops the oldest one; motions come a frame apart at most.
      [this.previous, this.current] = [this.current, this.previous];
      this.mix = 0;
    }
    this.current.start(motion, this.voices.length, tape, limit);
    this.target = 1;
    this.chasing = null;
    this.endAt = Infinity;
    this.step = 1 / FADE;
  }

  /** A shuttle: steady motion, as tape up to 1x and as grains faster. */
  run(motion: Motion) {
    this.begin(motion, false);
  }

  /**
   * A drag, reported at audio frame `now`. The sound runs as tape at the pointer's speed and
   * closes the gap to where it is, so pitch follows the pointer; once the pointer rests it fades.
   */
  chase(report: Chase, now: number) {
    const goal = report.position + report.velocity * (now - report.frame);
    const chasing = this.chasing;
    if (
      !chasing ||
      !this.current.motion ||
      Math.abs(goal - chasing.motion.position) > JUMP
    ) {
      const motion = { frame: now, position: goal, velocity: report.velocity };
      this.begin(motion, true);
      this.chasing = { report, received: now, motion };
      return;
    }
    chasing.report = report;
    chasing.received = now;
    this.target = 1;
  }

  /** One frame's samples, output samples `[position, position + length)`, from audio frame `now`. */
  blip(position: number, length: number, now: number) {
    this.begin({ frame: now, position, velocity: 1 }, true, {
      start: position,
      end: position + length,
    });
    this.step = 1 / EDGE;
    this.endAt = now + length - EDGE;
  }

  stop() {
    this.target = 0;
  }

  /** Whether anything plays or fades now. */
  get sounding() {
    return this.current.motion !== null;
  }

  /** Renders one block. False when idle, which leaves `out` untouched. */
  process(out: Float32Array, frame: number) {
    if (!this.current.motion) return false;
    if (this.now.length !== out.length) {
      this.now = new Float32Array(out.length);
      this.then = new Float32Array(out.length);
    }
    const chasing = this.chasing;
    let velocity = 0;
    if (chasing) {
      const { report, received, motion } = chasing;
      const resting = frame - received > report.rest;
      const goal =
        report.position +
        report.velocity *
          (Math.min(frame, received + report.rest) - report.frame);
      velocity = Math.max(
        -MAX_CHASE,
        Math.min(
          MAX_CHASE,
          (resting ? 0 : report.velocity) + (goal - motion.position) / LAG,
        ),
      );
      motion.velocity = velocity;
      if (resting) this.target = 0;
    }
    const crossing = this.previous.motion !== null;
    if (crossing)
      this.previous.render(this.then, frame, this.voices, this.reading);
    this.current.render(this.now, frame, this.voices, this.reading);
    // Left where the block ends, so a lane crossing out from here carries on from there.
    if (chasing) {
      chasing.motion.position += velocity * out.length;
      chasing.motion.frame += out.length;
    }
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      let value = this.now[i]!;
      if (crossing) {
        this.mix = Math.min(1, this.mix + 1 / FADE);
        value = this.then[i]! + (value - this.then[i]!) * this.mix;
      }
      if (frame + i >= this.endAt) this.target = 0;
      if (this.level !== this.target)
        this.level =
          this.target > this.level
            ? Math.min(this.target, this.level + this.step)
            : Math.max(this.target, this.level - this.step);
      out[i] = value * this.level;
      peak = Math.max(peak, Math.abs(out[i]!));
    }
    if (this.mix === 1) this.previous.motion = null;
    if (!this.level && !this.target) {
      this.current.motion = null;
      this.previous.motion = null;
      this.chasing = null;
    }
    this.reading.peak = peak;
    return true;
  }
}
