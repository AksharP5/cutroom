import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const fps = 30;
export const sourceSeconds = 120;
export const desktop4kSourceSeconds = 44;
export const clipCount = 100;
export const clipSeconds = 3;
export const duration = clipCount * clipSeconds;

/** Where clip `index` starts in the source, in seconds. Distinct enough that a cut always changes the number. */
export const mediaStart = (index: number, seconds = sourceSeconds) =>
  (index * 37) % (seconds - clipSeconds);

/** The source frame the picture shows at timeline second `t`, given the clips in order. */
export function expectedFrame(t: number, order: readonly number[]) {
  const slot = Math.floor(t / clipSeconds);
  const index = order[slot];
  if (index === undefined) return null;
  return Math.round((mediaStart(index) + t - slot * clipSeconds) * fps);
}

/**
 * A five-minute 1080p30 edit both editors open: 100 cuts from one numbered source, a music bed,
 * 20 titles and two placements of a sub-composition scene. 123 clips on four tracks. Every
 * source frame carries its number in sixteen blocks along the top, so a screencast can read
 * which frame the viewer shows.
 */
/**
 * A gentle look on every shot for `--grade`: warmer, a little more contrast and an S-curve, mild
 * enough that the frame numbers and the red anchor still read.
 */
export const benchGrade = {
  adjust: { temperature: 0.15, contrast: 0.1, saturation: 0.1 },
  curves: {
    master: [
      [0, 0],
      [0.25, 0.22],
      [0.75, 0.78],
      [1, 1],
    ],
  },
};

export async function makeProject(
  directory: string,
  graded = false,
  compatible = false,
  desktop?: "1080p" | "4k",
) {
  const width = desktop === "4k" ? 3840 : 1920;
  const height = desktop === "4k" ? 2160 : 1080;
  const seconds = desktop === "4k" ? desktop4kSourceSeconds : sourceSeconds;
  const count = desktop === "4k" ? 30 : clipCount;
  const length = count * clipSeconds;
  const marker = desktop
    ? `,drawbox=x=${(width * 15) / 16}:y=0:w=${width / 16}:h=${height / 20}:color=red:t=fill`
    : "";
  await mkdir(join(directory, "compositions"), { recursive: true });
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${width}x${height}:rate=${fps}:duration=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `nullsrc=size=16x1:rate=${fps}:duration=${seconds}`,
    "-filter_complex",
    `[1:v]format=gray,geq=lum='255*mod(floor(N/pow(2\\,X))\\,2)',scale=${width}:${height / 20}:flags=neighbor[bar];[0:v][bar]overlay=0:0${marker},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-b:v",
    desktop === "4k" ? "32M" : "8M",
    "-g",
    String(fps),
    "-movflags",
    "+faststart",
    "-y",
    join(directory, "footage.mp4"),
  ]);
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=0.2*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.5*t))|0.2*sin(2*PI*330*t):s=48000:d=${length}`,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-y",
    join(directory, "music.m4a"),
  ]);
  const gsap = compatible ? "assets/vendor/gsap.min.js" : "gsap.min.js";
  if (compatible)
    await mkdir(join(directory, "assets/vendor"), { recursive: true });
  await copyFile(
    resolve("node_modules/gsap/dist/gsap.min.js"),
    join(directory, gsap),
  );
  const cuts = Array.from(
    { length: count },
    (_, index) =>
      `<video id="shot-${index}"${compatible ? "" : ' class="clip"'} src="footage.mp4" muted data-start="${index * clipSeconds}" data-duration="${clipSeconds}" data-media-start="${mediaStart(index, seconds)}" data-track-index="0"${graded ? ` data-color-grading='${JSON.stringify(benchGrade)}'` : ""} style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`,
  );
  const music = `<audio id="music" class="clip" src="music.m4a" data-start="0" data-duration="${length}" data-track-index="1" data-volume="0.5"></audio>`;
  const titles = Array.from(
    { length: desktop === "4k" ? 6 : 20 },
    (_, index) =>
      `<div id="title-${index}" class="clip title" data-start="${index * 15 + 1}" data-duration="4" data-track-index="2">Chapter ${index + 1}</div>`,
  );
  const scenes = (desktop === "4k" ? [] : [60, 200]).map(
    (start, index) =>
      `<div id="scene-${index}" class="clip scene" data-composition-id="scene" data-composition-src="compositions/scene.html" data-start="${start}" data-duration="6" data-track-index="3" data-width="1920" data-height="1080"></div>`,
  );
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script src="${gsap}"></script>
<style>
html,body{margin:0;background:#000}
main{position:relative;width:${width}px;height:${height}px;overflow:hidden}
.title{position:absolute;left:120px;bottom:120px;padding:16px 32px;background:rgba(0,0,0,.7);color:#fff;font:600 64px sans-serif}
.scene{position:absolute;inset:0}
</style>
</head>
<body>
<main id="main" data-composition-id="main" data-width="${width}" data-height="${height}" data-duration="${length}" data-fps="${fps}">
${[...cuts, music, ...titles, ...scenes].join("\n")}
</main>
${compatible ? "" : "<script>window.__timelines=window.__timelines||{};window.__timelines.main=gsap.timeline({paused:true});</script>"}
</body>
</html>
`,
  );
  await writeFile(
    join(directory, "compositions/scene.html"),
    `<template><main data-composition-id="scene" data-width="1920" data-height="1080" data-duration="6"><div id="scene-card" style="position:absolute;right:120px;top:360px;width:520px;height:300px;background:#2b6cb0;color:#fff;font:700 56px sans-serif;display:flex;align-items:center;justify-content:center">Scene</div></main><script>{const tl=gsap.timeline({paused:true});tl.fromTo("#scene-card",{x:200,opacity:0},{x:0,opacity:1,duration:1},0);window.__timelines.scene=tl;}</script></template>
`,
  );
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target)
    throw new Error("Usage: node scripts/bench-vs-studio-project.ts <dir>");
  await makeProject(resolve(target));
  console.log(`Made ${resolve(target)}`);
}
