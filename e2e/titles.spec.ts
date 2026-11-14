import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { APIRequestContext, FrameLocator, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ExportJobSchema } from "../src/shared/export";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const FPS = 30;
/** Inside the lower-left plate of a 64 px title on 1920x1080, clear of its rounded corners. */
const PLATE = "crop=240:90:130:868";
const BACKGROUND = 17;
const WHITE_PLATE = "#ffffffff";

const result = <T>(schema: z.ZodType<T>, value: unknown) => {
  expect(
    z.object({ isError: z.boolean().optional() }).parse(value).isError,
    JSON.stringify(value),
  ).not.toBe(true);
  return z
    .object({ structuredContent: z.object({ result: schema }) })
    .parse(value).structuredContent.result;
};

const connect = async (baseURL: string) => {
  const client = new Client({ name: "title-clips", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: new URL(baseURL).origin } },
    }),
  );
  return client;
};

const editor = (client: Client, projectId: string, composition?: string) => {
  const read = async () =>
    result(
      TimelineViewSchema,
      await client.callTool({
        name: "timeline_read",
        arguments: { projectId, composition },
      }),
    );
  return {
    read,
    edit: async (commands: CommandInput[]) =>
      result(
        TimelineViewSchema,
        await client.callTool({
          name: "timeline_edit",
          arguments: {
            projectId,
            composition,
            expectedRevision: (await read()).revision,
            commands,
          },
        }),
      ),
  };
};

/** Mean grey level of the plate area, 0 to 255, in any image or video frame ffmpeg reads. */
const plateLevel = async (path: string, frames: number[] = [0]) => {
  const { stdout } = await promisify(execFile)(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      `select=${frames.map((frame) => `eq(n\\,${frame})`).join("+")},${PLATE},scale=1:1:flags=area,format=gray`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer" },
  );
  return [...stdout];
};

/** The frame as capture, `timeline_view` and note images render it. */
const captured = async (
  request: APIRequestContext,
  projectId: string,
  frame: number,
  path: string,
) => {
  const response = await request.get(
    `/api/projects/${projectId}/thumbnail/index.html?t=${frame / FPS}&format=png&output=source`,
  );
  expect(response.status(), await response.text()).toBe(200);
  await writeFile(path, await response.body());
  return (await plateLevel(path))[0]!;
};

const seek = async (page: Page, frame: number) => {
  await page
    .getByRole("button", { name: "Current time. Click to type a time." })
    .click();
  const field = page.getByRole("textbox", { name: "Go to time" });
  await field.pressSequentially(
    `0000${String(Math.floor(frame / FPS)).padStart(2, "0")}${String(frame % FPS).padStart(2, "0")}`,
  );
  await field.press("Enter");
};

/** A title's opacity in the viewer once the playhead has settled on `frame`. */
const opacityAt = async (
  page: Page,
  preview: FrameLocator,
  id: string,
  frame: number,
  settled: (opacity: number) => boolean,
) => {
  await seek(page, frame);
  let opacity = Number.NaN;
  await expect
    .poll(
      async () => {
        opacity = await preview
          .locator(`#${id}`)
          .evaluate((title) => Number(getComputedStyle(title).opacity));
        return settled(opacity);
      },
      { message: `${id} at frame ${frame}: opacity ${opacity}` },
    )
    .toBe(true);
  return opacity;
};
const hidden = (opacity: number) => opacity === 0;
const full = (opacity: number) => opacity === 1;
const partial = (opacity: number) => opacity > 0.02 && opacity < 0.98;

const lowerThird = (extra: Record<string, unknown> = {}): CommandInput => ({
  type: "insert",
  track: 3,
  at: 180,
  clip: {
    kind: "title",
    id: "lower",
    text: "Ada Lovelace",
    duration: 120,
    title: {
      font: "Instrument Sans",
      color: "#111111",
      plate: WHITE_PLATE,
      in: { preset: "fade", frames: 15 },
      out: { preset: "fade", frames: 15 },
      ...extra,
    },
  },
});

test("a title added over MCP keeps its entrance and exit on the clip through trims, a move and a razor, in the viewer and the export", async ({
  page,
  baseURL,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const client = await connect(baseURL!);
  const warnings: unknown[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (message) => {
    warnings.push(message.params);
  });
  try {
    const project = result(
      ProjectSchema,
      await client.callTool({
        name: "project_create",
        arguments: { name: "Title clips", duration: 12 },
      }),
    );
    const { edit } = editor(client, project.id);
    const added = await edit([
      { type: "setTrack", index: 3, kind: "video" },
      lowerThird(),
    ]);
    expect(
      added.timeline.clips.find((clip) => clip.id === "lower"),
    ).toMatchObject({ start: 180, duration: 120, text: "Ada Lovelace" });

    await page.goto(`/#project/${project.id}`);
    const preview = page.frameLocator("iframe[data-live]");
    await expect(preview.locator("#lower")).toHaveCount(1);
    const at = (
      id: string,
      frame: number,
      check: (opacity: number) => boolean,
    ) => opacityAt(page, preview, id, frame, check);

    // As inserted: [180, 300), in over 180..195, out over 285..300.
    await at("lower", 180, hidden);
    await at("lower", 186, partial);
    await at("lower", 240, full);
    await at("lower", 292, partial);
    const view = await client.callTool({
      name: "timeline_view",
      arguments: { projectId: project.id, frame: 186 },
    });
    expect(view.isError, JSON.stringify(view)).not.toBe(true);

    // Tail trim to [180, 270): the exit moves to 255..270 with no title command.
    await edit([{ type: "trim", clipId: "lower", edge: "end", to: 270 }]);
    await at("lower", 250, full);
    await at("lower", 262, partial);

    // Head trim to [200, 270): the whole entrance plays from the new first frame.
    await edit([{ type: "trim", clipId: "lower", edge: "start", to: 200 }]);
    await at("lower", 200, hidden);
    await at("lower", 206, partial);
    await at("lower", 220, full);

    // Move to [230, 300).
    await edit([{ type: "move", clipIds: ["lower"], by: 30 }]);
    await at("lower", 236, partial);
    await at("lower", 292, partial);

    // Razor at 260: the words hold across the cut, with one entrance and one exit overall.
    const cut = await edit([
      { type: "split", at: 260, clipIds: ["lower"], ids: { lower: ["tail"] } },
    ]);
    expect(
      cut.timeline.clips
        .filter((clip) => clip.title)
        .map((clip) => [
          clip.id,
          clip.title!.in.preset,
          clip.title!.out.preset,
        ]),
    ).toEqual([
      ["lower", "fade", "none"],
      ["tail", "none", "fade"],
    ]);
    await at("lower", 236, partial);
    await at("lower", 259, full);
    await at("tail", 260, full);
    await at("tail", 292, partial);
    await page.screenshot({ path: testInfo.outputPath("editor.png") });

    // Export [228, 302) and compare the plate with the captured preview, frame for frame.
    const start = 228;
    const frames = [229, 232, 250, 259, 260, 275, 296, 300];
    const started = result(
      z.object({ jobId: z.string() }),
      await client.callTool({
        name: "export_start",
        arguments: {
          projectId: project.id,
          range: { start, end: 302 },
          quality: "high",
        },
      }),
    );
    const status = async () =>
      result(
        ExportJobSchema,
        await client.callTool({ name: "export_status", arguments: started }),
      );
    await expect
      .poll(async () => (await status()).status, {
        timeout: 90_000,
        intervals: [250, 500],
      })
      .toBe("complete");
    const exported = await plateLevel(
      (await status()).outputPath,
      frames.map((frame) => frame - start),
    );
    const shown: number[] = [];
    for (const frame of frames)
      shown.push(
        await captured(
          request,
          project.id,
          frame,
          testInfo.outputPath(`preview-${frame}.png`),
        ),
      );
    await testInfo.attach("Plate level by frame", {
      body: JSON.stringify({ frames, shown, exported }),
      contentType: "application/json",
    });
    expect(exported).toHaveLength(frames.length);
    // The measure moves with the animation: background before, the white plate in the hold.
    const [before, entering, hold, , , , leaving, gone] = shown;
    expect(before).toBeLessThan(BACKGROUND + 4);
    expect(gone).toBeLessThan(BACKGROUND + 4);
    expect(hold).toBeGreaterThan(200);
    expect(entering).toBeGreaterThan(before! + 20);
    expect(entering).toBeLessThan(hold! - 20);
    expect(leaving).toBeGreaterThan(gone! + 20);
    expect(leaving).toBeLessThan(hold! - 20);
    // No dip at the cut.
    expect(shown[3]).toBe(hold!);
    expect(shown[4]).toBe(hold!);
    for (const [index, frame] of frames.entries())
      expect(
        Math.abs(exported[index]! - shown[index]!),
        `frame ${frame}: preview ${shown[index]}, export ${exported[index]}`,
      ).toBeLessThanOrEqual(4);
    // A title has no script, so no edit left animation behind.
    expect(warnings).toEqual([]);
  } finally {
    await client.close();
  }
});

test("a title's entrance plays in step with the playhead at 1x", async ({
  page,
  baseURL,
}) => {
  const client = await connect(baseURL!);
  try {
    const project = result(
      ProjectSchema,
      await client.callTool({
        name: "project_create",
        arguments: { name: "Title playback", duration: 12 },
      }),
    );
    await editor(client, project.id).edit([
      { type: "setTrack", index: 3, kind: "video" },
      { ...lowerThird(), at: 60 } as CommandInput,
    ]);
    await page.goto(`/#project/${project.id}`);
    const preview = page.frameLocator("iframe[data-live]");
    await expect(preview.locator("#lower")).toHaveCount(1);
    await opacityAt(page, preview, "lower", 50, hidden);

    const title = preview.locator("#lower");
    const collecting = title.evaluate(
      (element) =>
        new Promise<{ time: number; opacity: number }[]>((resolve) => {
          const player = (
            window as unknown as { __player: { getTime(): number } }
          ).__player;
          const samples: { time: number; opacity: number }[] = [];
          const sample = () => {
            const time = player.getTime();
            samples.push({
              time,
              opacity: Number(getComputedStyle(element).opacity),
            });
            if (time < 2.7) requestAnimationFrame(sample);
            else resolve(samples);
          };
          requestAnimationFrame(sample);
        }),
    );
    await page.keyboard.press("l");
    const samples = await collecting;
    await page.keyboard.press("k");

    // The same times parked: a playing sample must sit between its neighbours one frame away.
    const parked = (seconds: number) =>
      title.evaluate(async (element, time) => {
        const runtime = window as unknown as {
          __player: { seek(time: number): void | Promise<void> };
          __hfWaitForSeekCompletion?: () => Promise<void>;
        };
        await runtime.__player.seek(time);
        await runtime.__hfWaitForSeekCompletion?.();
        return Number(getComputedStyle(element).opacity);
      }, seconds);
    const moving = samples.filter(
      ({ time, opacity }) =>
        time > 2 && time < 2.5 && opacity > 0 && opacity < 1,
    );
    expect(moving.length).toBeGreaterThan(8);
    for (const { time, opacity } of moving) {
      const earlier = await parked(Math.max(2, time - 1 / FPS));
      const later = await parked(time + 1 / FPS);
      expect(
        opacity,
        `playing ${opacity} at ${time}s, parked ${earlier} to ${later}`,
      ).toBeGreaterThanOrEqual(earlier - 0.01);
      expect(opacity).toBeLessThanOrEqual(later + 0.01);
    }
    // Played through: nothing is left mid-entrance.
    expect(samples.at(-1)!.opacity).toBe(1);
  } finally {
    await client.close();
  }
});

test("a title inside a scene file animates in the scene's own time", async ({
  baseURL,
  request,
}, testInfo) => {
  const client = await connect(baseURL!);
  try {
    const project = result(
      ProjectSchema,
      await client.callTool({
        name: "project_create",
        arguments: { name: "Scene title", duration: 12 },
      }),
    );
    result(
      SourceSchema,
      await client.callTool({
        name: "source_write",
        arguments: {
          projectId: project.id,
          path: "compositions/scene.html",
          expectedVersion: null,
          content: `<template>\n<div id="scene-root" data-composition-id="scene" data-width="1920" data-height="1080" data-duration="4" style="position:absolute;inset:0">\n<div id="wash" class="clip" data-start="0" data-duration="4" data-track-index="0" style="position:absolute;inset:0"></div>\n</div>\n</template>\n`,
        },
      }),
    );
    const source = result(
      SourceSchema,
      await client.callTool({
        name: "source_read",
        arguments: { projectId: project.id },
      }),
    );
    result(
      SourceSchema,
      await client.callTool({
        name: "source_write",
        arguments: {
          projectId: project.id,
          expectedVersion: source.version,
          content: source.content.replace(
            "</main>",
            `<div id="scene" class="clip" data-composition-id="scene" data-composition-src="compositions/scene.html" data-start="2" data-duration="4" data-track-index="3" data-width="1920" data-height="1080"></div>\n</main>`,
          ),
        },
      }),
    );
    const scene = editor(client, project.id, "compositions/scene.html");
    const added = await scene.edit([
      { type: "setTrack", index: 1, kind: "video" },
      { ...lowerThird(), track: 1, at: 0 } as CommandInput,
    ]);
    expect(
      added.timeline.clips.find((clip) => clip.id === "lower")?.title,
    ).toMatchObject({ in: { preset: "fade", frames: 15 } });
    const written = result(
      SourceSchema,
      await client.callTool({
        name: "source_read",
        arguments: { projectId: project.id, path: "compositions/scene.html" },
      }),
    ).content;
    expect(written.startsWith("<template><style data-cutroom-")).toBe(true);
    expect(written.split("data-cutroom-titles").length).toBe(2);

    // The scene starts at 2 s on the root timeline: frames 60..180, in to 75, out from 165.
    const level = (frame: number) =>
      captured(
        request,
        project.id,
        frame,
        testInfo.outputPath(`scene-${frame}.png`),
      );
    const [before, entering, hold, leaving] = [
      await level(59),
      await level(62),
      await level(120),
      await level(176),
    ];
    expect(before).toBeLessThan(BACKGROUND + 4);
    expect(hold).toBeGreaterThan(200);
    expect(entering).toBeGreaterThan(before + 20);
    expect(entering).toBeLessThan(hold - 20);
    expect(leaving).toBeGreaterThan(before + 20);
    expect(leaving).toBeLessThan(hold - 20);
  } finally {
    await client.close();
  }
});
