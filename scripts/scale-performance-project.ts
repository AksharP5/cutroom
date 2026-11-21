import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { trackStackingStyle } from "../src/server/timeline/composition";
import { defaultTitle } from "../src/shared/timeline/title";
import { titleAttributes, titleStyle } from "../src/server/timeline/titles";
import {
  transitionAttributes,
  transitionStyle,
} from "../src/server/timeline/transitions";

import { scaleFps, scaleShots } from "./bench-vs-studio-project.ts";
import type { ScaleClipCount } from "./bench-vs-studio-project.ts";

const encode = promisify(execFile);
const fps = { num: scaleFps, den: 1 };

const attributes = (entries: [string, string | null][]) =>
  entries
    .map(([name, value]) => (value === null ? "" : ` ${name}="${value}"`))
    .join("");

/** A numbered 1080p60 dialogue edit, with linked sound, music, titles, punch-ins and dissolves. */
export async function makeScaleProject(
  directory: string,
  count: ScaleClipCount,
  { cameraMedia = false }: { cameraMedia?: boolean } = {},
) {
  await mkdir(directory, { recursive: true });
  const files = cameraMedia
    ? ["camera-a.mp4", "camera-b.mp4"]
    : ["footage.mp4"];
  const sourceSeconds = cameraMedia ? 75 : 30;
  const width = cameraMedia ? 1280 : 1920;
  const height = cameraMedia ? 720 : 1080;
  for (const [camera, file] of files.entries()) {
    await encode("ffmpeg", [
      "-v",
      "error",
      "-filter_complex_threads",
      "2",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${width}x${height}:rate=60:duration=${sourceSeconds}`,
      "-f",
      "lavfi",
      "-i",
      `nullsrc=size=16x1:rate=60:duration=${sourceSeconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${330 + camera * 110}:sample_rate=48000:duration=${sourceSeconds}`,
      "-filter_complex",
      `[1:v]format=gray,geq=lum='255*mod(floor(N/pow(2\\,X))\\,2)',scale=${width}:${height / 20}:flags=neighbor[bar];[0:v][bar]overlay,format=yuv420p`,
      "-c:v",
      "libx264",
      "-threads",
      "3",
      "-preset",
      "ultrafast",
      "-crf",
      "25",
      "-g",
      cameraMedia ? "120" : "60",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-y",
      join(directory, file),
    ]);
  }
  const shots = scaleShots(count, sourceSeconds * scaleFps);
  const duration = shots.at(-1)!.end / scaleFps;
  const musicCount = count === 1000 ? 4 : 2;
  const musicLength = duration / musicCount;
  await encode("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=0.1*sin(2*PI*220*t)|0.1*sin(2*PI*440*t):s=48000:d=${musicLength}`,
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-y",
    join(directory, "music.m4a"),
  ]);
  const dissolve = new Set(
    [0.56, 0.76, 0.96].map((fraction) => Math.floor(shots.length * fraction)),
  );
  const transition = {
    kind: "dissolve",
    duration: 24,
    alignment: "center",
  } as const;
  const media = shots.flatMap(({ start, end, source }, index) => {
    const incoming = dissolve.has(index);
    const outgoing = dissolve.has(index + 1);
    const lead = incoming ? 12 : 0;
    const tail = outgoing ? 12 : 0;
    const edges = attributes([
      ...transitionAttributes("in", incoming ? transition : null, false, fps),
      ...transitionAttributes("out", outgoing ? transition : null, true, fps),
    ]);
    const crop =
      index > 0 && index % Math.floor(shots.length / 5) === 0
        ? ";transform:scale(1.35)"
        : "";
    const link = `data-link="pair-${index}"`;
    const footage = files[Math.floor(index / 24) % files.length]!;
    return [
      `<video id="shot-${index}" src="${footage}" muted ${link} data-start="${(start - lead) / scaleFps}" data-duration="${(end - start + lead + tail) / scaleFps}" data-media-start="${(source - lead) / scaleFps}" data-track-index="0"${edges} style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover${crop}"></video>`,
      `<audio id="voice-${index}" src="${footage}" ${link} data-start="${start / scaleFps}" data-duration="${(end - start) / scaleFps}" data-media-start="${source / scaleFps}" data-track-index="1"></audio>`,
    ];
  });
  const music = Array.from(
    { length: musicCount },
    (_, index) =>
      `<audio id="music-${index}" src="music.m4a" data-start="${index * musicLength}" data-duration="${musicLength}" data-track-index="2" data-volume="0.4"></audio>`,
  );
  const titleCount = count === 1000 ? 24 : 6;
  const title = defaultTitle(fps);
  const style = attributes(titleAttributes(title, fps));
  const titles = Array.from(
    { length: titleCount },
    (_, index) =>
      `<div id="title-${index}" class="clip" data-start="${3 + index * Math.floor(duration / titleCount)}" data-duration="2" data-track-index="3"${style}>Chapter ${index + 1}</div>`,
  );
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html>
<html><head>${trackStackingStyle("main", [0, 3])}
<meta charset="utf-8"><style>html,body{margin:0;background:#000}</style>
${titleStyle([])}${transitionStyle()}</head><body>
<main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="${duration}" data-fps="${scaleFps}">
${[...media, ...music, ...titles].join("\n")}
</main></body></html>
`,
  );
  return shots;
}

if (import.meta.main) {
  const [directory, count] = process.argv.slice(2);
  if (!directory || (count !== "100" && count !== "1000"))
    throw new Error(
      "Usage: bun scripts/scale-performance-project.ts <directory> <100|1000>",
    );
  await makeScaleProject(directory, count === "1000" ? 1000 : 100);
}
