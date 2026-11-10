import { mediaSettings, peakLevels } from "../../shared/media";

export const peakSampleRate = mediaSettings.peakSampleRate;
export const peakBucketSamples = mediaSettings.peakBucketSamples;
const mipCount = peakLevels.length;
const headerBytes = 32 + mipCount * 16;

/** CRPK v2: little-endian header, level directory, then signed int16 min/max pairs. */
export async function encodePeaks(
  stream: ReadableStream<Uint8Array>,
  channels = 1,
) {
  const base: number[] = [];
  let minimum = 32767;
  let maximum = -32768;
  let bucketSamples = 0;
  let totalSamples = 0;
  let channel = 0;
  let lowByte: number | undefined;
  for await (const chunk of stream) {
    for (const byte of chunk) {
      if (lowByte === undefined) {
        lowByte = byte;
        continue;
      }
      const unsigned = lowByte | (byte << 8);
      const sample = unsigned >= 32768 ? unsigned - 65536 : unsigned;
      lowByte = undefined;
      minimum = Math.min(minimum, sample);
      maximum = Math.max(maximum, sample);
      if (++channel !== channels) continue;
      channel = 0;
      totalSamples++;
      if (++bucketSamples !== peakBucketSamples) continue;
      base.push(minimum, maximum);
      bucketSamples = 0;
      minimum = 32767;
      maximum = -32768;
    }
  }
  if (lowByte !== undefined || channel !== 0)
    throw new Error("Truncated PCM audio.");
  if (!totalSamples) throw new Error("The media has no decoded audio samples.");
  if (bucketSamples) base.push(minimum, maximum);
  const levels = [base];
  for (let level = 1; level < mipCount; level++) {
    const previous = levels[level - 1]!;
    const pairs: number[] = [];
    for (
      let index = 0;
      index < previous.length;
      index += mediaSettings.mipFactor * 2
    ) {
      let min = 32767;
      let max = -32768;
      for (
        let pair = index;
        pair < Math.min(index + mediaSettings.mipFactor * 2, previous.length);
        pair += 2
      ) {
        min = Math.min(min, previous[pair]!);
        max = Math.max(max, previous[pair + 1]!);
      }
      pairs.push(min, max);
    }
    levels.push(pairs);
  }
  const output = Buffer.alloc(
    headerBytes + levels.reduce((bytes, pairs) => bytes + pairs.length * 2, 0),
  );
  output.write("CRPK", 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(mipCount, 8);
  output.writeUInt32LE(peakSampleRate, 12);
  output.writeDoubleLE(totalSamples, 16);
  output.writeUInt32LE(peakBucketSamples, 24);
  let offset = headerBytes;
  for (const [index, pairs] of levels.entries()) {
    const entry = 32 + index * 16;
    output.writeUInt32LE(peakLevels[index]!, entry);
    output.writeUInt32LE(pairs.length / 2, entry + 4);
    output.writeUInt32LE(offset, entry + 8);
    output.writeUInt32LE(pairs.length * 2, entry + 12);
    for (const sample of pairs) {
      output.writeInt16LE(sample, offset);
      offset += 2;
    }
  }
  return output;
}
