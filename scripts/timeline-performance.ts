import { execFile } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { titleAttributes, titleStyle } from "../src/server/timeline/titles";
import { defaultTitle } from "../src/shared/timeline/title";

const fps = { num: 30, den: 1 };

/** The engine benchmark's linked talking-head cuts and titles, with drawable source media. */
export async function timelineWorkload(
  request: APIRequestContext,
  count: 400 | 500,
  media?: string,
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: `${count} clip timeline performance` },
      })
    ).json(),
  );
  const target = join(project.path, "talk.mp4");
  if (media) await copyFile(media, target);
  else
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
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
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      target,
    ]);
  const pairs = (count - 20) / 2;
  const pieces = Array.from({ length: pairs }, (_, index) => {
    const timing = `data-start="${index * 2.5}" data-duration="2.5" data-media-start="${(index * 3) % 57}"`;
    return `<video id="talk-${index}" src="talk.mp4" muted data-link="lk-${index}" ${timing} data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video>
<audio id="voice-${index}" src="talk.mp4" data-link="lk-${index}" ${timing} data-track-index="1"></audio>`;
  });
  // Cutroom titles, so the budgets include their stylesheet and exit animation. No entrance, so a
  // title is drawn on its first frame, where the picture tests click it.
  const title = defaultTitle(fps);
  const titleSettings = titleAttributes(
    { ...title, in: { ...title.in, preset: "none" } },
    fps,
  )
    .map(([name, value]) => (value === null ? "" : ` ${name}="${value}"`))
    .join("");
  const titles = Array.from(
    { length: 20 },
    (_, index) =>
      `<div id="title-${index}" class="clip" data-start="${(index * pairs * 2.5) / 20}" data-duration="4" data-track-index="2"${titleSettings}>Chapter ${index + 1}</div>`,
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#111}</style>${titleStyle([])}</head><body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="${pairs * 2.5}" data-fps="30">${[...pieces, ...titles].join("\n")}</main></body></html>`,
  );
  for (const kind of ["filmstrip", "peaks"] as const) {
    const deadline = performance.now() + 60_000;
    for (;;) {
      const response = await request.get(
        `/api/cutroom/projects/${project.id}/media/${kind}?path=talk.mp4`,
      );
      if (response.status() === 200) break;
      if (response.status() !== 202) throw new Error(await response.text());
      if (performance.now() > deadline) throw new Error(`${kind} timed out.`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return project;
}

const interactions = ["key", "wheel", "ripple", "undo", "redo", "fit"] as const;
export type TimelineInteraction = (typeof interactions)[number];

/** Samples displayed frames through the real keymap, including the save and history response. */
export function timelineFrames(page: Page, interaction: TimelineInteraction) {
  return page.evaluate(
    async ({ interaction, trace }) => {
      const frames: number[] = [];
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ type: "longtask" });
      const frame = () =>
        new Promise<number>((resolve) =>
          requestAnimationFrame(() => resolve(performance.now())),
        );
      let previous = await frame();
      const start = performance.now();
      performance.mark(`${interaction}:start`);
      const key = (code: string, modifiers: KeyboardEventInit = {}) =>
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            code,
            ...modifiers,
            bubbles: true,
            cancelable: true,
          }),
        );
      if (interaction === "ripple") key("Delete");
      if (interaction === "undo") key("KeyZ", { ctrlKey: true });
      if (interaction === "redo")
        key("KeyZ", { ctrlKey: true, shiftKey: true });
      if (interaction === "fit") key("KeyZ", { shiftKey: true });
      let steps = 0;
      let nextKey = 0;
      let lastInput = start;
      while (
        performance.now() - start < (interaction === "key" ? 1600 : 1000) ||
        (interaction === "key" &&
          (steps < 12 || performance.now() - lastInput < 300)) ||
        (interaction === "wheel" && steps < 16)
      ) {
        if (
          interaction === "key" &&
          steps < 12 &&
          performance.now() - start >= nextKey
        ) {
          key("Equal", { ctrlKey: true });
          steps++;
          lastInput = performance.now();
          nextKey += 100;
        }
        if (interaction === "wheel" && steps < 16) {
          steps++;
          const scroller = document.querySelector(".tl-scroll");
          if (!scroller) throw new Error("The timeline is missing.");
          const rect = scroller.getBoundingClientRect();
          scroller.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: -24,
              ctrlKey: true,
              clientX: rect.x + 350,
              clientY: rect.y + 80,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        const now = await frame();
        frames.push(now - previous);
        if (trace && now - previous > 20)
          performance.mark(`frame-gap:${(now - previous).toFixed(3)}`);
        previous = now;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      observer.disconnect();
      performance.mark(`${interaction}:end`);
      return { interaction, frames, longTasks, inputs: steps };
    },
    { interaction, trace: process.env.CUTROOM_PERF_TRACE === "1" },
  );
}

export function frameSummary(
  results: Awaited<ReturnType<typeof timelineFrames>>[],
) {
  return Object.fromEntries(
    interactions.map((interaction) => {
      const runs = results.filter(
        (result) => result.interaction === interaction,
      );
      const frames = runs
        .flatMap((result) => result.frames)
        .sort((a, b) => a - b);
      const maxima = runs
        .map((result) => Math.max(...result.frames))
        .sort((a, b) => a - b);
      const longTasks = runs.flatMap((result) => result.longTasks);
      return [
        interaction,
        {
          p50: frames[Math.floor(frames.length * 0.5)],
          p95: frames[Math.floor(frames.length * 0.95)],
          max: frames.at(-1),
          medianMax: maxima[Math.floor(maxima.length / 2)],
          longTasks: longTasks.length,
          longestTask: Math.max(0, ...longTasks),
        },
      ];
    }),
  );
}
