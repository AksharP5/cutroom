import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { ExportJobSchema } from "../src/shared/export";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { formatTimecode } from "../src/shared/timeline/timecode";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

const ffmpeg = promisify(execFile);
const width = 432;
const height = 240;
const digits = 8;
const cell = width / (digits + 1);
const shotLength = 13;
const cuts = [
  { kind: "dissolve", alignment: "center", before: 1, duration: 3 },
  { kind: "dissolve", alignment: "start", before: 0, duration: 6 },
  { kind: "dissolve", alignment: "end", before: 6, duration: 6 },
  { kind: "dip", alignment: "center", before: 2, duration: 4 },
  { kind: "dip", alignment: "start", before: 0, duration: 6 },
  { kind: "dip", alignment: "end", before: 6, duration: 6 },
] as const;
const offsets = [17, 80, 80, 86, 82, 80, 86, 80];
const total = offsets.length * shotLength;

async function numberedSource(path: string, rate: string, band: number) {
  // Each clip's white reference and binary frame number occupy a different half of the
  // picture from its neighbour. Read both numbers independently even during a dissolve.
  const boxes = Array.from(
    { length: digits + 1 },
    (_, bit) =>
      `drawbox=x=${Math.floor(bit * cell)}:y=${(band * height) / 2}:w=${Math.floor(cell)}:h=${height / 2}:color=white:t=fill${bit === digits ? "" : `:enable='eq(mod(floor(n/${2 ** bit}),2),1)'`}`,
  );
  await ffmpeg("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=black:s=${width}x${height}:r=${rate}`,
    "-frames:v",
    "120",
    "-vf",
    boxes.join(","),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    "15",
    path,
  ]);
}

/** A band's decoded frame number, or null when it is black. */
function numbers(rgb: Uint8Array, w: number, h: number, stride: number) {
  return [0, 1].map((band) => {
    const cellAt = (bit: number) =>
      rgb[
        (Math.floor(((band + 0.5) * h) / 2) * w +
          Math.floor(((bit + 0.5) * w) / (digits + 1))) *
          stride
      ]!;
    const white = cellAt(digits);
    if (white < 12) return null;
    return Array.from({ length: digits }, (_, bit) =>
      cellAt(bit) > white / 2 ? 2 ** bit : 0,
    ).reduce((sum, bit) => sum + bit, 0);
  });
}

const samples = cuts.flatMap(({ kind, before, duration }, index) => {
  const cut = (index + 1) * shotLength;
  return Array.from({ length: duration + 2 }, (_, step) => {
    const progress = step - 1;
    const at = cut - before + progress;
    const outgoing = offsets[index]! + at - index * shotLength;
    const incoming = offsets[index + 1]! + at - cut;
    const expected: (number | null)[] = [null, null];
    if (kind === "dissolve" ? progress < duration : progress < duration / 2)
      expected[index % 2] = outgoing;
    if (
      progress >= duration ||
      (kind === "dissolve" ? progress > 0 : progress > duration / 2)
    )
      expected[(index + 1) % 2] = incoming;
    return { at, expected };
  });
});
// Also check a hard cut after the transitions.
samples.push({ at: total - 3, expected: [null, offsets[7]! + shotLength - 3] });

async function imageCells(page: Page, image: string) {
  const rgb = await page.evaluate(
    async ({ encoded, cells }) => {
      const bmp = await createImageBitmap(
        new Blob([
          Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
        ]),
      );
      const canvas = new OffscreenCanvas(cells, 2);
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bmp, 0, 0, cells, 2);
      bmp.close();
      return Array.from(ctx.getImageData(0, 0, cells, 2).data);
    },
    { encoded: image, cells: digits + 1 },
  );
  return Uint8Array.from(rgb);
}

const frameBytes = width * height * 3;
const rawOptions = [
  "-f",
  "rawvideo",
  "-pix_fmt",
  "rgb24",
  "-threads",
  "1",
  "pipe:1",
];

for (const fps of [
  { num: 30000, den: 1001 },
  { num: 60000, den: 1001 },
  { num: 30, den: 1 },
  { num: 25, den: 1 },
]) {
  const rate = `${fps.num}/${fps.den}`;
  test(`transition handles keep the intended source frames at ${rate}`, async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: `Numbered transitions ${rate}`, width, height },
        })
      ).json(),
    );
    const route = `/api/cutroom/projects/${project.id}`;
    const seconds = (frame: number) => ((frame * fps.den) / fps.num).toFixed(6);
    await Promise.all(
      [0, 1].map((band) =>
        numberedSource(join(project.path, `${band}.mp4`), rate, band),
      ),
    );
    const composition = join(project.path, "index.html");
    const source = `<!doctype html><html><head><style>html,body{margin:0;background:#000}</style></head><body>
<main data-composition-id="main" data-width="${width}" data-height="${height}" data-fps="${rate}" data-duration="${seconds(total)}">
${offsets.map((offset, index) => `<video id="v${index}" src="${index % 2}.mp4" muted data-start="${seconds(index * shotLength)}" data-duration="${seconds(shotLength)}" data-media-start="${seconds(offset)}" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video>`).join("\n")}
</main></body></html>`;
    await writeFile(composition, source);
    const view = TimelineViewSchema.parse(
      await (await request.get(`${route}/timeline`)).json(),
    );
    const edited = await request.post(`${route}/commands`, {
      data: {
        composition: "index.html",
        expectedRevision: view.revision,
        label: "Transitions",
        commands: cuts.map(({ kind, alignment, duration }, index) => ({
          type: "setTransition",
          from: `v${index}`,
          to: `v${index + 1}`,
          transition: { kind, alignment, duration },
        })),
      },
    });
    expect(edited.ok(), await edited.text()).toBe(true);

    const render = async (
      format: "mp4" | "mov",
      range: "timeline" | { start: number; end: number },
      direct = false,
    ) => {
      const start = range === "timeline" ? 0 : range.start;
      const length = range === "timeline" ? total : range.end - range.start;
      const response = await request.post(
        `/api/projects/${project.id}/export`,
        {
          data: {
            format,
            range,
            directory: project.path,
            gpu: false,
          },
        },
      );
      const body = await response.text();
      expect.soft(response.ok(), body).toBe(true);
      if (!response.ok()) return null;
      const { jobId } = z.object({ jobId: z.string() }).parse(JSON.parse(body));
      await request.get(`/api/render/${jobId}/progress`, { timeout: 90_000 });
      const job = ExportJobSchema.parse(
        await (await request.get(`/api/render/${jobId}`)).json(),
      );
      expect.soft(job.status, job.error ?? format).toBe("complete");
      if (job.status !== "complete") return null;
      expect(job.encoder).toBe(direct ? "libx264" : undefined);
      const { stdout } = await ffmpeg(
        "ffmpeg",
        ["-v", "error", "-i", job.outputPath, ...rawOptions],
        { encoding: "buffer", maxBuffer: length * frameBytes * 2 },
      );
      expect(stdout.length).toBe(length * frameBytes);
      return (at: number) =>
        numbers(stdout.subarray((at - start) * frameBytes), width, height, 3);
    };

    for (const format of ["mp4", "mov"] as const) {
      if (format === "mov" && fps.den === 1001) {
        // Old projects could store a handle one microsecond below its canonical value.
        const handle = fps.num === 30000 ? 79 : 80;
        const oldOffset = fps.num === 30000 ? "2.635966" : "1.334666";
        const attribute = `data-media-start="${seconds(handle)}"`;
        const saved = await readFile(composition, "utf8");
        const clipId = fps.num === 30000 ? "v1" : "v4";
        const clip = new RegExp(`<video id="${clipId}"[^>]+>`).exec(saved)?.[0];
        expect(clip).toContain(attribute);
        await writeFile(
          composition,
          saved.replace(
            clip!,
            clip!.replace(attribute, `data-media-start="${oldOffset}"`),
          ),
        );
      }
      const frame = await render(format, "timeline");
      if (!frame) continue;
      for (const { at, expected } of samples)
        expect
          .soft(frame(at), `${format} at output frame ${at}`)
          .toEqual(expected);
    }

    await page.goto(`/#project/${project.id}`);
    const stage = page.locator(".edit-stage[data-preview-ready]");
    await expect(stage).toBeVisible();
    for (const { at, expected } of samples) {
      await page
        .getByRole("button", { name: "Current time. Click to type a time." })
        .click();
      const time = page.getByRole("textbox", { name: "Go to time" });
      await time.pressSequentially(formatTimecode(at, fps).replaceAll(":", ""));
      await time.press("Enter");
      await expect
        .poll(async () => {
          const handle = await page
            .locator("iframe[data-live]")
            .elementHandle();
          const preview = await handle?.contentFrame();
          return preview?.evaluate(({ num, den }) => {
            const time = (
              window as { __player?: { getTime(): number } }
            ).__player?.getTime();
            return time === undefined ? null : Math.round((time * num) / den);
          }, fps);
        })
        .toBe(at);
      await expect(stage).toBeVisible();
      expect
        .soft(
          numbers(
            await imageCells(
              page,
              (await page.locator(".edit-picture").screenshot()).toString(
                "base64",
              ),
            ),
            digits + 1,
            2,
            4,
          ),
          `paused preview at output frame ${at}`,
        )
        .toEqual(expected);
    }

    const client = new Client({ name: "numbered-transitions", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
          requestInit: { headers: { origin: new URL(baseURL!).origin } },
        }),
      );
      for (let i = 0; i < samples.length; i += 6) {
        const batch = samples.slice(i, i + 6);
        const result = await client.callTool({
          name: "timeline_view",
          arguments: {
            projectId: project.id,
            frames: batch.map(({ at }) => at),
          },
        });
        const { content } = z
          .object({
            content: z.array(
              z.object({
                type: z.string(),
                data: z.string().optional(),
              }),
            ),
          })
          .parse(result);
        const images = content.flatMap(({ type, data }) =>
          type === "image" && data ? [data] : [],
        );
        expect(images, JSON.stringify(result).slice(0, 200)).toHaveLength(
          batch.length,
        );
        for (const [index, data] of images.entries()) {
          const { at, expected } = batch[index]!;
          expect
            .soft(
              numbers(await imageCells(page, data), digits + 1, 2, 4),
              `timeline_view at output frame ${at}`,
            )
            .toEqual(expected);
        }
      }
    } finally {
      await client.close();
    }

    // FFmpeg draws one unblended source at a time. Remove the transitions and seek into
    // the same incoming shot using a marked export to exercise the direct planner's offset.
    await page.close();
    await writeFile(composition, source);
    const start = shotLength + 1;
    const end = start + 4;
    const frame = await render("mp4", { start, end }, true);
    if (frame)
      for (let at = start; at < end; at++)
        expect(frame(at), `FFmpeg at output frame ${at}`).toEqual([
          null,
          offsets[1]! + at - shotLength,
        ]);
  });
}

const dissolveFrames = 24;
const gradeCuts = [32, 72, 112, 152];
const exposures = [0, 0, -0.5, -0.5, 0];
const gradeStarts = [0, ...gradeCuts];
const gradeOffsets = [10, 24, 32, 40, 48];
const gradeEnd = 180;

function whiteReferences(
  rgb: Uint8Array,
  w: number,
  h: number,
  stride: number,
) {
  return [0, 1].map(
    (band) =>
      rgb[
        (Math.floor(((band + 0.5) * h) / 2) * w +
          Math.floor(((digits + 0.5) * w) / (digits + 1))) *
          stride
      ]!,
  );
}

for (const fps of [
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
]) {
  const rate = `${fps.num}/${fps.den}`;
  for (const track of [0, 1]) {
    test(`graded dissolves preserve the mix on V${track + 1} at ${rate}`, async ({
      browser,
      request,
    }) => {
      test.setTimeout(180_000);
      const project = ProjectSchema.parse(
        await (
          await request.post("/api/cutroom/projects", {
            data: {
              name: `Graded dissolves V${track + 1} ${rate}`,
              width,
              height,
            },
          })
        ).json(),
      );
      const route = `/api/cutroom/projects/${project.id}`;
      const seconds = (frame: number) =>
        ((frame * fps.den) / fps.num).toFixed(6);
      await Promise.all(
        [0, 1].map((band) =>
          numberedSource(join(project.path, `${band}.mp4`), rate, band),
        ),
      );
      const video = (
        id: string,
        band: number,
        at: number,
        end: number,
        offset: number,
        lane: number,
      ) =>
        `<video id="${id}" src="${band}.mp4" muted data-start="${seconds(at)}" data-duration="${seconds(end - at)}" data-media-start="${seconds(offset)}" data-track-index="${lane}" style="position:absolute;inset:0;width:100%;height:100%"></video>`;
      // Put the last outgoing shot above its incoming partner. Both fade-in and fade-out
      // must work when the fading shot is graded.
      const clips = [0, 1, 2, 4, 3].map((i) =>
        video(
          `v${i}`,
          i % 2,
          gradeStarts[i]!,
          gradeCuts[i] ?? gradeEnd,
          gradeOffsets[i]!,
          track,
        ),
      );
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><head><style>html,body{margin:0;background:#000}</style></head><body>
<main data-composition-id="main" data-width="${width}" data-height="${height}" data-fps="${rate}" data-duration="${seconds(gradeEnd)}">
${track ? video("lower-a", 0, 0, 90, 0, 0) + video("lower-b", 1, 90, gradeEnd, 0, 0) : ""}
${clips.join("\n")}
</main></body></html>`,
      );
      const view = TimelineViewSchema.parse(
        await (await request.get(`${route}/timeline`)).json(),
      );
      const edited = await request.post(`${route}/commands`, {
        data: {
          composition: "index.html",
          expectedRevision: view.revision,
          commands: [
            ...gradeCuts.map((_, i) => ({
              type: "setTransition",
              from: `v${i}`,
              to: `v${i + 1}`,
              transition: {
                kind: "dissolve",
                duration: dissolveFrames,
                alignment: "center",
              },
            })),
            ...exposures.flatMap((exposure, i) =>
              exposure
                ? [
                    {
                      type: "setClip",
                      clipId: `v${i}`,
                      grade: { adjust: { exposure } },
                    },
                  ]
                : [],
            ),
          ],
        },
      });
      expect(edited.ok(), await edited.text()).toBe(true);

      const windows = gradeCuts.map((cut, index) =>
        Array.from({ length: dissolveFrames + 1 }, (_, step) => {
          const at = cut - dissolveFrames / 2 + step;
          const numbers: (number | null)[] = [null, null];
          const whites = [0, 0];
          const bands = [index % 2, (index + 1) % 2];
          for (const [side, band] of bands.entries()) {
            const clip = index + side;
            const gain = 2 ** exposures[clip]!;
            const mix = side
              ? step / dissolveFrames
              : 1 - step / dissolveFrames;
            whites[band] = 255 * gain * mix;
            if (mix > 0)
              numbers[band] = gradeOffsets[clip]! + at - gradeStarts[clip]!;
          }
          return { at, numbers, whites };
        }),
      );
      const check = (
        mode: string,
        white: number[],
        decoded: (number | null)[],
        sample: (typeof windows)[number][number],
      ) => {
        for (const [band, target] of sample.whites.entries()) {
          expect
            .soft(
              Math.abs(white[band]! - target),
              `${mode} frame ${sample.at}, band ${band}: measured ${white[band]}, expected ${target.toFixed(1)}`,
            )
            .toBeLessThanOrEqual(5);
          if (target >= 18)
            expect
              .soft(
                decoded[band],
                `${mode} frame ${sample.at}, band ${band} source number`,
              )
              .toBe(sample.numbers[band]);
        }
      };
      const response = await request.post(
        `/api/projects/${project.id}/export`,
        {
          data: {
            format: "mp4",
            range: "timeline",
            directory: project.path,
            gpu: false,
          },
        },
      );
      expect(response.ok(), await response.text()).toBe(true);
      const { jobId } = z
        .object({ jobId: z.string() })
        .parse(await response.json());
      await request.get(`/api/render/${jobId}/progress`, { timeout: 90_000 });
      const job = ExportJobSchema.parse(
        await (await request.get(`/api/render/${jobId}`)).json(),
      );
      expect(job.status, job.error ?? "MP4").toBe("complete");
      const { stdout } = await ffmpeg(
        "ffmpeg",
        ["-v", "error", "-i", job.outputPath, ...rawOptions],
        {
          encoding: "buffer",
          maxBuffer: gradeEnd * frameBytes * 2,
        },
      );
      expect(stdout.length).toBe(gradeEnd * frameBytes);
      for (const sample of windows.flat()) {
        const frame = stdout.subarray(
          sample.at * frameBytes,
          (sample.at + 1) * frameBytes,
        );
        check(
          "MP4",
          whiteReferences(frame, width, height, 3),
          numbers(frame, width, height, 3),
          sample,
        );
      }

      for (const pipeline of [false, true]) {
        const context = await browser.newContext({
          viewport: { width: 1720, height: 1050 },
        });
        try {
          await context.addInitScript((enabled) => {
            if (window === window.top)
              localStorage.setItem("cutroom.footagePipeline", String(enabled));
          }, pipeline);
          const page = await context.newPage();
          await page.goto(`/#project/${project.id}`);
          const stage = page.locator(".edit-stage[data-preview-ready]");
          await expect(stage).toBeVisible();

          const runtime = page
            .frameLocator("iframe[data-live]")
            .locator("body");
          for (const [step, sample] of windows.flat().entries()) {
            if (step % (dissolveFrames + 1))
              await page.keyboard.press("ArrowRight");
            else await seekFrame(page, sample.at);
            await expect
              .poll(() =>
                runtime.evaluate((_, { num, den }) => {
                  const time = (
                    window as { __player?: { getTime(): number } }
                  ).__player?.getTime();
                  return time === undefined
                    ? null
                    : Math.round((time * num) / den);
                }, fps),
              )
              .toBe(sample.at);
            await expect(stage).toBeVisible();
            if (pipeline)
              await expect(stage).toHaveAttribute("data-pipeline", "on");
            const png = await page.locator(".edit-picture").screenshot();
            const rgb = await imageCells(page, png.toString("base64"));
            check(
              pipeline ? "GPU viewer" : "Native viewer",
              whiteReferences(rgb, digits + 1, 2, 4),
              numbers(rgb, digits + 1, 2, 4),
              sample,
            );
          }
        } finally {
          await context.close();
        }
      }
    });
  }
}
