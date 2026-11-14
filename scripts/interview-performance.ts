import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { defaultTitle } from "../src/shared/timeline/title";
import { titleAttributes, titleStyle } from "../src/server/timeline/titles";

/** PR #117's interview layout, with the four authored GSAP titles replaced by Cutroom titles. */
export async function interviewWorkload(request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Interview b-roll music and Cutroom titles",
          width: 1920,
          height: 1080,
          duration: 60,
        },
      })
    ).json(),
  );
  for (const args of [
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30:duration=60",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=0.4*sin(2*PI*330*t)*(0.5+0.5*sin(2*PI*0.8*t)):s=16000:d=60",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-g",
      "60",
      "-threads",
      "2",
      "-c:a",
      "aac",
      "-shortest",
      join(project.path, "interview.mp4"),
    ],
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=30:duration=20",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "26",
      "-g",
      "60",
      "-threads",
      "2",
      join(project.path, "broll.mp4"),
    ],
    [
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=0.15*sin(2*PI*220*t)+0.08*sin(2*PI*330*t):s=48000:d=60",
      join(project.path, "music.wav"),
    ],
  ])
    await promisify(execFile)("ffmpeg", ["-v", "error", "-y", ...args]);
  const pieces = Array.from({ length: 10 }, (_, i) => {
    const timing = `data-start="${i * 6}" data-duration="6" data-media-start="${i * 5}"`;
    return `<video id="interview-${i}" src="interview.mp4" muted data-link="iv-${i}" ${timing} data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video><audio id="voice-${i}" src="interview.mp4" data-link="iv-${i}" ${timing} data-track-index="1"></audio>`;
  });
  const broll = Array.from(
    { length: 4 },
    (_, i) =>
      `<video id="broll-${i}" src="broll.mp4" muted data-start="${8 + i * 12}" data-duration="4" data-media-start="${i * 4}" data-track-index="2" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`,
  );
  const attributes = titleAttributes(
    {
      ...defaultTitle({ num: 30, den: 1 }),
      font: "Instrument Sans",
      plate: "#222222ff",
    },
    { num: 30, den: 1 },
  )
    .flatMap(([name, value]) => (value === null ? [] : [` ${name}="${value}"`]))
    .join("");
  const titles = Array.from(
    { length: 4 },
    (_, i) =>
      `<div id="title-${i}" class="clip" data-start="${i * 15}" data-duration="4" data-track-index="4"${attributes}>Interview chapter ${i + 1}</div>`,
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>
    @font-face{font-family:"Instrument Sans";src:url(assets/fonts/InstrumentSans-var.woff2);font-weight:400 700}
    html,body{margin:0;background:#111}main{position:relative;overflow:hidden;width:1920px;height:1080px}
    </style>${titleStyle(["Instrument Sans"])}</head><body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="60" data-fps="30">${pieces.join("\n")}${broll.join("\n")}<audio id="music" src="music.wav" data-start="0" data-duration="60" data-volume="0.25" data-track-index="3"></audio>${titles.join("\n")}</main></body></html>`,
  );
  return project;
}
