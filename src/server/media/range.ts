import { open } from "node:fs/promises";
import { HttpError } from "../../shared/errors";

/** A range remains a CRPK file, with one level and its first bucket index in header byte 28. */
export async function peakRange(
  path: string,
  level: number,
  start: number,
  end: number,
) {
  const file = await open(path, "r");
  const header = Buffer.alloc(48);
  let offset: number;
  let length: number;
  let first: number;
  let last: number;
  try {
    await file.read(header, 0, 32, 0);
    const levels = header.readUInt32LE(8);
    if (level >= levels)
      throw new HttpError(400, "That waveform level does not exist.");
    await file.read(header, 32, 16, 32 + level * 16);
    const width = header.readUInt32LE(32) / header.readUInt32LE(12);
    const count = header.readUInt32LE(36);
    first = Math.min(count, Math.floor(start / width));
    last = Math.max(first, Math.min(count, Math.ceil(end / width)));
    offset = header.readUInt32LE(40) + first * 4;
    length = (last - first) * 4;
    header.writeUInt32LE(1, 8);
    header.writeUInt32LE(first, 28);
    header.writeUInt32LE(last - first, 36);
    header.writeUInt32LE(48, 40);
    header.writeUInt32LE(length, 44);
  } finally {
    await file.close();
  }
  const reader = Bun.file(path)
    .slice(offset, offset + length)
    .stream()
    .getReader();
  let sentHeader = false;
  return {
    variant: `${level}-${first}-${last}`,
    length: 48 + length,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sentHeader) {
          sentHeader = true;
          controller.enqueue(header);
          return;
        }
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
  };
}
