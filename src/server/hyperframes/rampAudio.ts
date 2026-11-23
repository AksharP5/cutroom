import { mkdtemp, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { MAX_PLAYBACK_RATE } from "@hyperframes/parsers/media-duration";
import {
  MAX_WAV_FRAMES,
  runFrames,
  runSourceTime,
} from "../../shared/timeline/rampRuns.ts";
import type { RampRun } from "../../shared/timeline/rampRuns.ts";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_BYTES = CHANNELS * 2;
const BLOCK = SAMPLE_RATE * 0.03;
const INTERVAL = SAMPLE_RATE * 0.005;
type Stretch = {
  HEAP8: Int8Array;
  _configure(
    channels: number,
    block: number,
    interval: number,
    split: number,
  ): void;
  _inputLatency(): number;
  _outputLatency(): number;
  _setBuffers(channels: number, frames: number): number;
  _seek(frames: number, rate: number): void;
  _process(inputFrames: number, outputFrames: number): void;
  _flush(frames: number): void;
};

const require = createRequire(import.meta.url);

/** The pinned mixer hands us stereo 48 kHz PCM. FFmpeg may include metadata before the data chunk. */
async function pcmData(file: FileHandle) {
  const header = Buffer.alloc(12);
  await file.read(header, 0, header.length, 0);
  if (
    header.toString("ascii", 0, 4) !== "RIFF" ||
    header.toString("ascii", 8) !== "WAVE"
  )
    throw new Error("Decoded ramp audio is not PCM WAV.");
  const chunk = Buffer.alloc(8);
  for (let offset = 12; offset < header.readUInt32LE(4) + 8;) {
    const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
    if (bytesRead !== chunk.length) break;
    const size = chunk.readUInt32LE(4);
    if (chunk.toString("ascii", 0, 4) === "data")
      return { offset: offset + 8, bytes: size };
    offset += 8 + size + (size % 2);
  }
  throw new Error("Decoded ramp audio has no PCM data.");
}

export function wavHeader(frames: number) {
  const bytes = frames * FRAME_BYTES;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(bytes + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * FRAME_BYTES, 28);
  header.writeUInt16LE(FRAME_BYTES, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}

/**
 * Stretch `frames` output samples whose source sample at output sample `j` is `sourceAt(j)`
 * (absolute source seconds). `pcm` holds the source from `origin`, a whole source sample. Source
 * before 0 or past what was decoded is silence. The stretcher reads and writes in fixed blocks.
 */
async function stretchAudio(
  pcmPath: string | null,
  origin: number,
  destination: string,
  frames: number,
  sourceAt: (frame: number) => number,
  signal?: AbortSignal,
) {
  const createStretch =
    require("./vendor/signalsmith-stretch.cjs") as (options: {
      crypto: { getRandomValues: (bytes: Uint8Array) => Uint8Array };
    }) => Promise<Stretch>;
  // The library randomizes phase at slow speeds. Seed every run identically
  // so the same run is rendered the same way for the viewer and every export.
  const stretch = await createStretch({
    crypto: { getRandomValues: (bytes) => bytes.fill(0x51) },
  });
  stretch._configure(CHANNELS, BLOCK, INTERVAL, 0);
  const inputLatency = stretch._inputLatency();
  const outputLatency = stretch._outputLatency();
  // The extra frame covers rounding the two source endpoints.
  const capacity = Math.max(
    INTERVAL * MAX_PLAYBACK_RATE + 1,
    inputLatency,
    outputLatency,
  );
  const pointer = stretch._setBuffers(CHANNELS, capacity);
  const channels = Array.from(
    { length: 2 * CHANNELS },
    (_, channel) =>
      new Float32Array(
        stretch.HEAP8.buffer,
        pointer + channel * capacity * 4,
        capacity,
      ),
  );
  const [leftIn, rightIn, leftOut, rightOut] = channels as [
    Float32Array,
    Float32Array,
    Float32Array,
    Float32Array,
  ];
  const input = Buffer.alloc(capacity * FRAME_BYTES);
  const output = Buffer.alloc(Math.max(INTERVAL, outputLatency) * FRAME_BYTES);
  const begin = Math.round(sourceAt(0) * SAMPLE_RATE);
  const sourceFrame = (frame: number) =>
    Math.round(sourceAt(frame) * SAMPLE_RATE) - begin;

  const reader = pcmPath ? await open(pcmPath, "r") : null;
  try {
    const pcm = reader ? await pcmData(reader) : { offset: 0, bytes: 0 };
    const writer = await open(destination, "w");
    try {
      await writer.writeFile(wavHeader(frames));
      const feed = async (start: number, count: number) => {
        signal?.throwIfAborted();
        const absolute = begin + start;
        // Source before its first sample is silence.
        const silent = Math.min(count, Math.max(0, -absolute));
        const position = (absolute + silent - origin) * FRAME_BYTES;
        const length = Math.max(
          0,
          Math.min((count - silent) * FRAME_BYTES, pcm.bytes - position),
        );
        input.fill(0, 0, silent * FRAME_BYTES);
        const { bytesRead } =
          reader && length
            ? await reader.read(
                input,
                silent * FRAME_BYTES,
                length,
                pcm.offset + position,
              )
            : { bytesRead: 0 };
        input.fill(0, silent * FRAME_BYTES + bytesRead, count * FRAME_BYTES);
        for (let index = 0; index < count; index++) {
          leftIn[index] = input.readInt16LE(index * FRAME_BYTES) / 32768;
          rightIn[index] = input.readInt16LE(index * FRAME_BYTES + 2) / 32768;
        }
      };
      const collect = async (offset: number, count: number) => {
        // Drop the processor's startup samples. The flush supplies the matching tail.
        let bytes = 0;
        for (
          let index = Math.max(0, outputLatency - offset);
          index < count;
          index++
        ) {
          output.writeInt16LE(
            Math.round(
              Math.max(-1, Math.min(32767 / 32768, leftOut[index]!)) * 32768,
            ),
            bytes,
          );
          output.writeInt16LE(
            Math.round(
              Math.max(-1, Math.min(32767 / 32768, rightOut[index]!)) * 32768,
            ),
            bytes + 2,
          );
          bytes += FRAME_BYTES;
        }
        if (bytes) await writer.writeFile(output.subarray(0, bytes));
      };

      const first = Math.min(INTERVAL, frames);
      await feed(0, inputLatency);
      stretch._seek(inputLatency, sourceFrame(first) / first);
      for (let from = 0; from < frames; from += INTERVAL) {
        const to = Math.min(frames, from + INTERVAL);
        const sourceFrom = sourceFrame(from);
        const sourceFrames = sourceFrame(to) - sourceFrom;
        await feed(sourceFrom + inputLatency, sourceFrames);
        stretch._process(sourceFrames, to - from);
        await collect(from, to - from);
      }
      signal?.throwIfAborted();
      stretch._flush(outputLatency);
      await collect(frames, outputLatency);
    } finally {
      await writer.close();
    }
  } finally {
    await reader?.close();
  }
}

type Decode<Result> = (
  path: string,
  start: number,
  seconds: number,
) => Promise<Result>;

/**
 * Decode on HyperFrames' source clock, then stretch once before clip and bus effects. `sourceAt`
 * gives the absolute source seconds at each of `frames` output samples. Undefined when the
 * output or its source would not fit in a WAV.
 */
export async function prepareStretch<
  Result extends { success: boolean; outputPath: string },
>(
  destination: string,
  frames: number,
  sourceAt: (frame: number) => number,
  decode: Decode<Result>,
  signal?: AbortSignal,
): Promise<Result | undefined> {
  const begin = Math.round(sourceAt(0) * SAMPLE_RATE);
  const end = Math.round(sourceAt(frames) * SAMPLE_RATE);
  if (frames < 1 || frames > MAX_WAV_FRAMES || end - begin > MAX_WAV_FRAMES)
    return;
  signal?.throwIfAborted();
  const origin = Math.max(0, begin);
  const directory = await mkdtemp(join(dirname(destination), ".audio-ramp-"));
  try {
    // A run that lies wholly before the source starts is silence.
    if (end <= origin) {
      await stretchAudio(null, origin, destination, frames, sourceAt, signal);
      return { success: true, outputPath: destination } as Result;
    }
    const source = join(directory, "source.wav");
    const result = await decode(
      source,
      origin / SAMPLE_RATE,
      (end - origin) / SAMPLE_RATE,
    );
    if (result.success)
      await stretchAudio(source, origin, destination, frames, sourceAt, signal);
    return { ...result, outputPath: destination };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A run's samples, stretched from its first sample so every piece that slices it joins seamlessly. */
export const prepareRampRun = <
  Result extends { success: boolean; outputPath: string },
>(
  destination: string,
  run: RampRun,
  decode: Decode<Result>,
  signal?: AbortSignal,
) =>
  prepareStretch(
    destination,
    runFrames(run),
    (frame) => runSourceTime(run, frame),
    decode,
    signal,
  );

/** Copy run samples `[from, to)` into a WAV of their own, a block at a time. */
export async function sliceRun(
  run: string,
  destination: string,
  from: number,
  to: number,
) {
  const reader = await open(run, "r");
  try {
    const pcm = await pcmData(reader);
    if (from < 0 || to <= from || to * FRAME_BYTES > pcm.bytes)
      throw new Error("The ramp audio run does not cover this clip.");
    const writer = await open(destination, "w");
    try {
      await writer.writeFile(wavHeader(to - from));
      const buffer = Buffer.alloc(INTERVAL * 64 * FRAME_BYTES);
      for (let at = from * FRAME_BYTES; at < to * FRAME_BYTES;) {
        const length = Math.min(buffer.length, to * FRAME_BYTES - at);
        const { bytesRead } = await reader.read(
          buffer,
          0,
          length,
          pcm.offset + at,
        );
        if (bytesRead !== length)
          throw new Error("The ramp audio run ended early.");
        await writer.writeFile(buffer.subarray(0, length));
        at += length;
      }
    } finally {
      await writer.close();
    }
  } finally {
    await reader.close();
  }
}
