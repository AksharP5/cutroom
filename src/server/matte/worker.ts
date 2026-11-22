import { setPriority } from "node:os";
import { rm } from "node:fs/promises";
import { localMediaInputOptions } from "../media/input.ts";
import { MatteTaskSchema } from "./protocol.ts";
import type { MatteEvent, MatteTask, Segmenter } from "./protocol.ts";

/** Below interactive work: playback and the editor keep their pace while a matte is made. */
const NICE = 10;

const send = (event: MatteEvent) =>
  process.stdout.write(`${JSON.stringify(event)}\n`);

/** Reads whole frames of `bytes` from a stream of arbitrary chunks. */
async function* frames(stream: ReadableStream<Uint8Array>, bytes: number) {
  let frame = new Uint8Array(bytes);
  let filled = 0;
  for await (const chunk of stream) {
    let at = 0;
    while (at < chunk.length) {
      const take = Math.min(bytes - filled, chunk.length - at);
      frame.set(chunk.subarray(at, at + take), filled);
      filled += take;
      at += take;
      if (filled === bytes) {
        yield frame;
        frame = new Uint8Array(bytes);
        filled = 0;
      }
    }
  }
}

function decodeArgs(task: MatteTask, size: number) {
  const scale = `scale=${size}:${size}:flags=lanczos,format=rgb24`;
  const input = ["-v", "error", "-nostdin", "-threads", "2"];
  if (!task.range)
    return [...input, "-i", task.source, "-frames:v", "1", "-vf", scale];
  const { seek, frames, rate, variable } = task.range;
  return [
    ...input,
    ...localMediaInputOptions,
    // An accurate seek half a frame early keeps the first frame and drops the one before.
    ...["-ss", seek.toFixed(6), "-i", task.source],
    ...["-frames:v", String(frames), "-an", "-sn"],
    // A constant-rate source gives one picture per frame; a variable one is read at grid slots.
    ...(variable
      ? ["-vf", `fps=${rate},${scale}`]
      : ["-fps_mode", "passthrough", "-vf", scale]),
  ];
}

function encodeArgs(task: MatteTask, size: number) {
  const rate = task.range?.rate ?? "1";
  return [
    ...["-v", "error", "-nostdin", "-y", "-threads", "2"],
    ...["-f", "rawvideo", "-pix_fmt", "gray", "-s", `${size}x${size}`],
    ...["-r", rate, "-i", "pipe:0"],
    // H.264 so the footage pipeline's MP4 demuxer and WebCodecs read it like any source: the
    // mask is the limited-range luma plane. No B-frames and short GOPs for quick seeks.
    ...["-vf", "scale=out_range=tv:out_color_matrix=bt709,format=yuv420p"],
    ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-bf", "0"],
    ...["-g", "30", "-profile:v", "high"],
    ...["-colorspace", "bt709", "-color_primaries", "bt709"],
    ...["-color_trc", "bt709", "-color_range", "tv"],
    ...["-movflags", "+faststart", "-an", task.output],
  ];
}

async function run(task: MatteTask) {
  const { createSegmenter } = (await import(task.segmenter)) as {
    createSegmenter: (options: MatteTask["model"]) => Promise<Segmenter>;
  };
  const segmenter = await createSegmenter(task.model);
  const { size } = segmenter;
  const decode = Bun.spawn(
    [task.ffmpeg, ...decodeArgs(task, size), "-f", "rawvideo", "pipe:1"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const encode = Bun.spawn([task.ffmpeg, ...encodeArgs(task, size)], {
    stdin: "pipe",
    stderr: "pipe",
  });
  const tail = (stream: ReadableStream<Uint8Array>) =>
    new Response(stream).text().then((text) => text.slice(-4000));
  const decodeErrors = tail(decode.stderr);
  const encodeErrors = tail(encode.stderr);
  let stopping = false;
  process.on("SIGTERM", () => {
    // Keep what is made: finish the file with the frames already written.
    stopping = true;
    decode.kill();
  });
  const empty = new Uint8Array(size * size);
  let done = 0;
  let subject = false;
  try {
    for await (const rgb of frames(decode.stdout, size * size * 3)) {
      if (stopping) break;
      const mask = await segmenter.segment(rgb);
      if (stopping) break;
      subject ||= mask !== null;
      encode.stdin.write(mask ?? empty);
      await encode.stdin.flush();
      send({ type: "progress", done: ++done });
    }
  } catch (error) {
    // A model that fails mid-run leaves no file, and no FFmpeg holding the worker open.
    decode.kill("SIGKILL");
    encode.kill("SIGKILL");
    await Promise.all([decode.exited, encode.exited]);
    await rm(task.output, { force: true });
    throw error;
  }
  await encode.stdin.end();
  const [decoded, encoded] = await Promise.all([decode.exited, encode.exited]);
  await segmenter.close();
  if (!stopping && decoded !== 0)
    throw new Error(`FFmpeg could not read the source. ${await decodeErrors}`);
  if (done && encoded !== 0)
    throw new Error(`FFmpeg could not write the matte. ${await encodeErrors}`);
  if (!done || !subject) await rm(task.output, { force: true });
  if (!done && !stopping)
    throw new Error("The source has no frames in that range.");
  send({ type: "done", done, subject });
}

setPriority(NICE);
const task = MatteTaskSchema.parse(await new Response(Bun.stdin).json());
await run(task).catch((error: unknown) => {
  send({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
