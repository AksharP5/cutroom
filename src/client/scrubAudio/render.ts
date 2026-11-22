import { gainAt, sourcePosition } from "./segment";
import type { Segment } from "./segment";

/** Samples per PCM chunk: 5.5 s, 512 KB. A power of two, so a sample's chunk is a shift. */
export const CHUNK_SAMPLES = 1 << 18;
/** A grain: 40 ms at 48 kHz. Grains overlap by half, so two always sound. */
export const GRAIN = 1920;
const HOP = GRAIN / 2;
/** Clips that sound at once; the rest under the playhead stay silent. */
const MAX_VOICES = 16;

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

/** The source sample at a fractional index, straight between neighbours; silence where no chunk is held. */
function read(chunks: Voice["chunks"], at: number) {
  const index = Math.floor(at);
  const fraction = at - index;
  const a = sample(chunks, index);
  return fraction ? a + (sample(chunks, index + 1) - a) * fraction : a;
}

const sample = (chunks: Voice["chunks"], k: number) =>
  (chunks.get(k >> 18)?.[k & (CHUNK_SAMPLES - 1)] ?? 0) / 32768;

/** One voice at output sample `n`, or nothing outside its segment. */
function voiceAt({ segment, chunks }: Voice, n: number, reading: Reading) {
  if (n < segment.samples.start || n >= segment.samples.end) return 0;
  const source = sourcePosition(segment, n);
  reading.source = Math.floor(source);
  return read(chunks, source) * gainAt(segment.gain, n);
}

/**
 * Renders one block starting at audio frame `frame`. Up to 1x either way it is a tape: every
 * output sample reads the next position, so pitch follows speed and reverse is the forward
 * sound backwards. Faster, it overlap-adds 40 ms grains read at normal pitch, each starting
 * where the motion has reached and played backwards in reverse.
 */
export function renderBlock(
  out: Float32Array,
  frame: number,
  motion: Motion,
  voices: readonly Voice[],
  reading: Reading,
) {
  const { velocity } = motion;
  const at = (f: number) => motion.position + (f - motion.frame) * velocity;
  const grains = Math.abs(velocity) > 1;
  const reach = grains ? GRAIN : 1;
  const from = at(frame - (grains ? GRAIN : 0));
  const to = at(frame + out.length);
  const low = Math.min(from, to) - reach;
  const high = Math.max(from, to) + reach;
  const sounding: Voice[] = [];
  for (const voice of voices) {
    if (sounding.length === MAX_VOICES) break;
    const { start, end } = voice.segment.samples;
    if (start <= high && end > low) sounding.push(voice);
  }
  out.fill(0);
  reading.peak = 0;
  if (!sounding.length) return;

  const direction = Math.sign(velocity);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    if (!grains) {
      const n = at(frame + i);
      for (const voice of sounding) sum += voiceAt(voice, n, reading);
    } else {
      const t = frame + i - motion.frame;
      const k = Math.floor(t / HOP);
      const j = t - k * HOP;
      // The grain that began this hop, and the one before it, half a grain in.
      const anchor = motion.position + k * HOP * velocity;
      const before = anchor - HOP * velocity;
      for (const voice of sounding)
        sum +=
          window[j]! * voiceAt(voice, anchor + direction * j, reading) +
          window[j + HOP]! *
            voiceAt(voice, before + direction * (j + HOP), reading);
    }
    out[i] = sum;
    reading.peak = Math.max(reading.peak, Math.abs(sum));
  }
}
