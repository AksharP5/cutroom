import { mkdtemp, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { sourceTimeAt } from "@hyperframes/core";
import type { RateSpec } from "@hyperframes/core";
import { MAX_PLAYBACK_RATE } from "@hyperframes/parsers/media-duration";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_BYTES = CHANNELS * 2;
const BLOCK = SAMPLE_RATE * 0.03;
const INTERVAL = SAMPLE_RATE * 0.005;
const MAX_WAV_FRAMES = Math.floor((0xffffffff - 36) / FRAME_BYTES);

type RateLane = Exclude<RateSpec, number>;
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

function wavHeader(frames: number) {
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

async function stretchAudio(
  source: string,
  destination: string,
  lane: RateLane,
  frames: number,
  signal?: AbortSignal,
) {
  const createStretch =
    require("./vendor/signalsmith-stretch.cjs") as (options: {
      crypto: { getRandomValues: (bytes: Uint8Array) => Uint8Array };
    }) => Promise<Stretch>;
  // The library randomizes phase at slow speeds. Seed every clip identically
  // so the same clip is rendered the same way in whole and marked exports.
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
  const sourceFrame = (frame: number) =>
    Math.round(sourceTimeAt(lane, frame / SAMPLE_RATE) * SAMPLE_RATE);

  const reader = await open(source, "r");
  try {
    const pcm = await pcmData(reader);
    const writer = await open(destination, "w");
    try {
      await writer.writeFile(wavHeader(frames));
      const feed = async (start: number, count: number) => {
        signal?.throwIfAborted();
        const position = start * FRAME_BYTES;
        const length = Math.max(
          0,
          Math.min(count * FRAME_BYTES, pcm.bytes - position),
        );
        const { bytesRead } = await reader.read(
          input,
          0,
          length,
          pcm.offset + position,
        );
        input.fill(0, bytesRead, count * FRAME_BYTES);
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
    await reader.close();
  }
}

/** Decode on HyperFrames' source clock, then stretch once before its clip and bus effects. */
export async function prepareRampAudio<
  Result extends { success: boolean; outputPath: string },
>(
  destination: string,
  duration: number,
  lane: RateLane,
  decode: (path: string, seconds: number) => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result | undefined> {
  const frames = Math.round(duration * SAMPLE_RATE);
  const sourceFrames = Math.round(
    sourceTimeAt(lane, frames / SAMPLE_RATE) * SAMPLE_RATE,
  );
  if (frames < 1 || frames > MAX_WAV_FRAMES || sourceFrames > MAX_WAV_FRAMES)
    return;
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(dirname(destination), ".audio-ramp-"));
  try {
    const source = join(directory, "source.wav");
    const result = await decode(source, sourceFrames / SAMPLE_RATE);
    if (result.success)
      await stretchAudio(source, destination, lane, frames, signal);
    return { ...result, outputPath: destination };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
