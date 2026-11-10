import { join } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { encodePeaks, peakSampleRate } from "./peaks";
import { FilmstripSchema, MediaTaskSchema } from "./protocol";

declare const self: Worker;
let child: ReturnType<typeof Bun.spawn> | undefined;
let cancelled = false;
let stopTimeout: ReturnType<typeof setTimeout> | undefined;
const inputOptions = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,mp3,wav,flac,aac,ogg,aiff,avi,asf,mpeg,mpegts,flv",
];

async function run(
  args: string[],
  consume?: (stream: ReadableStream<Uint8Array>) => Promise<unknown>,
) {
  if (cancelled) throw new Error("Media job cancelled.");
  const process = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  child = process;
  let tail = "";
  const errors = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of process.stderr)
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-8000);
  })();
  try {
    const result = await (consume
      ? consume(process.stdout)
      : new Response(process.stdout).text());
    const code = await process.exited;
    await errors;
    if (cancelled) throw new Error("Media job cancelled.");
    if (code !== 0)
      throw new Error(tail.trim() || `FFmpeg exited with code ${code}.`);
    return result;
  } finally {
    if (process.exitCode === null) process.kill("SIGKILL");
    await process.exited;
    await errors;
    clearTimeout(stopTimeout);
    stopTimeout = undefined;
    child = undefined;
  }
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  const task = MediaTaskSchema.parse(event.data);
  if (task.type === "cancel") {
    cancelled = true;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      stopTimeout ??= setTimeout(() => child?.kill("SIGKILL"), 1000);
    }
    return;
  }
  try {
    if (task.kind === "peaks") {
      await run(
        [
          task.ffmpeg,
          "-nostdin",
          "-v",
          "error",
          ...inputOptions,
          "-threads",
          "1",
          "-i",
          task.source,
          "-map",
          "0:a:0",
          "-vn",
          "-ac",
          "1",
          "-ar",
          String(peakSampleRate),
          "-c:a",
          "pcm_s16le",
          "-f",
          "s16le",
          "pipe:1",
        ],
        async (stream) => {
          const peaks = await encodePeaks(stream);
          await Bun.write(join(task.directory, "peaks.bin"), peaks);
        },
      );
    } else {
      const frames = join(task.directory, "frames");
      await mkdir(frames);
      await run([
        task.ffmpeg,
        "-nostdin",
        "-v",
        "error",
        ...inputOptions,
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-i",
        task.source,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        "fps=1/2:start_time=0:round=up,scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,setsar=1",
        "-frames:v",
        "3601",
        "-threads",
        "1",
        join(frames, "frame-%06d.png"),
      ]);
      const count = (await readdir(frames)).length;
      if (count > 3600)
        throw new Error("Filmstrip previews support media up to two hours.");
      if (!count) throw new Error("The media has no decoded video frames.");
      const columns = Math.min(10, count);
      const metadata = FilmstripSchema.parse({
        version: 1,
        interval: 2,
        tileWidth: 160,
        tileHeight: 90,
        count,
        columns,
        rows: Math.ceil(count / columns),
      });
      await run([
        task.ffmpeg,
        "-nostdin",
        "-v",
        "error",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-framerate",
        "1",
        "-i",
        join(frames, "frame-%06d.png"),
        "-vf",
        `tile=${columns}x${metadata.rows}:nb_frames=${count}`,
        "-frames:v",
        "1",
        "-threads",
        "1",
        "-q:v",
        "4",
        "-update",
        "1",
        join(task.directory, "sprite.jpg"),
      ]);
      await rm(frames, { recursive: true });
      await Bun.write(
        join(task.directory, "filmstrip.json"),
        JSON.stringify(metadata),
      );
    }
    self.postMessage({ type: "done" });
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
