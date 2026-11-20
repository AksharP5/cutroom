import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sampleGridAudio } from "../../src/server/hyperframes/audioClock.ts";
import {
  directAudioStage,
  registerRenderIsolation,
} from "../../src/server/hyperframes/renderIsolation.ts";

const [dir, name, num, den, count, markIn, markOut] = process.argv.slice(2);
if (!dir || !name || !num || !den || !count)
  throw new Error("Missing mix fixture arguments.");
const verify = registerRenderIsolation();
const { collectRenderMedia } = await import("@hyperframes/producer");
const { mixRangeAudio } =
  await import("../../src/server/hyperframes/rangeAudio.ts");
verify();

const fps = { num: Number(num), den: Number(den) };
const totalFrames = Number(count);
const html = await readFile(join(dir, `${name}.html`), "utf8");
const scene = await readFile(join(dir, "scene.html"), "utf8");
const audios = sampleGridAudio(
  collectRenderMedia(html).audios,
  html,
  new Map([["scene.html", scene]]),
);
const workDir = join(dir, name, "plan", "work");
await mkdir(workDir, { recursive: true });
const abortSignal = new AbortController().signal;
const mix = directAudioStage();
const common = {
  projectDir: dir,
  workDir,
  audioGain: 1,
  ffmpegProcessTimeout: 30_000,
  abortSignal,
  assertNotAborted: () => abortSignal.throwIfAborted(),
};
const result =
  markIn && markOut
    ? await mixRangeAudio(
        { composition: { audios }, totalFrames, workDir },
        { fps, frames: { start: Number(markIn), end: Number(markOut) } },
        (stage) => mix({ ...common, ...stage }),
      )
    : await mix({
        ...common,
        fps,
        totalFrames,
        audios,
        keepDeliverySource: true,
      });
if (!result.hasAudio || !result.deliverySourcePath)
  throw new Error("The mixer did not leave its PCM.");
