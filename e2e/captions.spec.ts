import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, FrameLocator, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { CaptionsViewSchema } from "../src/shared/captions";
import { ExportJobSchema } from "../src/shared/export";
import {
  ProjectSchema,
  SourceSchema,
  TranscriptViewSchema,
} from "../src/shared/project";
import { expect, test } from "./fixtures";

const FPS = 30;
const SRT = [
  "1",
  "00:00:00,500 --> 00:00:02,000",
  "<i>Make room</i> for this",
  "",
  "2",
  "00:00:02,500 --> 00:00:04,000",
  "Cut these words",
  "",
  "3",
  "00:00:04,500 --> 00:00:06,000",
  "Keep the ending",
  "",
].join("\n");
/** The caption band: the lower title-safe area of a 1920 x 1080 frame. */
const BAND = "crop=iw*1536/1920:ih*160/1080:iw*192/1920:ih*820/1080";

/** A project whose root plays an 8 s clip with sound, ready for a transcript. */
async function footageProject(request: APIRequestContext, name: string) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name, duration: 8 },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x3a5f7f:s=1920x1080:r=30:d=8",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=8",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "talk.mp4"),
  ]);
  const source = SourceSchema.parse(
    await (
      await request.get(
        `/api/cutroom/projects/${project.id}/source?path=index.html`,
      )
    ).json(),
  );
  const content = source.content
    .replace(/<div id="(headline|caption)"[^\n]*<\/div>\n/g, "")
    .replace(
      "</main>",
      '<video id="talk" class="clip" src="talk.mp4" style="position:absolute;inset:0;width:100%;height:100%" data-start="0" data-duration="8" data-track-index="1" data-has-audio="true"></video>\n</main>',
    );
  const written = await request.put(
    `/api/cutroom/projects/${project.id}/source`,
    {
      data: { path: "index.html", content, expectedVersion: source.version },
    },
  );
  expect(written.status(), await written.text()).toBe(200);
  return project;
}

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

/** The caption line the viewer shows, with the spoken word in brackets. */
const shownAt = async (
  page: Page,
  preview: FrameLocator,
  frame: number,
  expected: string,
) => {
  await seek(page, frame);
  await expect
    .poll(() =>
      preview.locator(".caption-group").evaluateAll((groups) =>
        groups
          .filter((group) => {
            // The runtime hides lines outside their time; they keep their layout box.
            const style = getComputedStyle(group);
            return style.visibility !== "hidden" && style.display !== "none";
          })
          .map((group) =>
            [...group.querySelectorAll(".caption-word")]
              .map((word) => {
                const style = getComputedStyle(word);
                const marked =
                  style.color === "rgb(255, 213, 74)" ||
                  style.backgroundColor === "rgb(255, 213, 74)";
                return marked ? `[${word.textContent}]` : word.textContent;
              })
              .join(" "),
          )
          .join(" | "),
      ),
    )
    .toBe(expected);
};

test("a person imports subtitles, adds captions, restyles and corrects them, and they follow a script cut", async ({
  page,
  request,
}, info) => {
  const project = await footageProject(request, "Captions by hand");
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Script", exact: true }).click();
  await page.locator('.script-panel input[type="file"]').setInputFiles({
    name: "talk.srt",
    mimeType: "text/plain",
    buffer: Buffer.from(SRT),
  });
  await expect(page.locator(".transcript-words")).toHaveText(
    /Make room for this Cut these words Keep the ending/,
  );
  await page.getByRole("button", { name: "Add captions" }).click();
  const style = page.getByRole("combobox", { name: "Caption style" });
  await expect(style).toHaveText("Karaoke");
  const preview = page.frameLocator("iframe[data-live]");
  // Each cue is a line; "Make room for this" spends its 1.5 s by word length.
  await shownAt(page, preview, 30, "Make [room] for this");
  await shownAt(page, preview, 110, "Cut these [words]");

  await style.click();
  await page.getByRole("option", { name: "Word highlight" }).click();
  await expect(style).toHaveText("Word highlight");
  await shownAt(page, preview, 30, "Make [room] for this");

  await page.locator(".transcript-words button", { hasText: /^room/ }).click();
  await page.getByRole("button", { name: "Edit caption" }).click();
  await page.getByRole("textbox", { name: "Caption text" }).fill("<b>ROOM</b>");
  await page.getByRole("button", { name: "Save" }).click();
  await shownAt(page, preview, 30, "Make [<b>ROOM</b>] for this");

  const secondCue = page.locator(".transcript-words button", {
    hasText: /^Cut/,
  });
  await secondCue.click();
  await page.getByRole("button", { name: "Edit caption" }).click();
  await page.getByRole("textbox", { name: "Caption text" }).fill("Remove");
  await page.getByRole("button", { name: "Save" }).click();
  await shownAt(page, preview, 110, "Remove these [words]");
  await page
    .locator(".edit-picture")
    .screenshot({ path: info.outputPath("before-cut.png") });

  // Cutting the second cue's words ripples the footage 1.5 s earlier; its captions follow.
  await secondCue.click();
  await page
    .locator(".transcript-words button", { hasText: /^words/ })
    .click({ modifiers: ["Shift"] });
  await page
    .locator(".script-selection-bar")
    .getByRole("button", { name: "Cut", exact: true })
    .click();
  await shownAt(page, preview, 125, "Keep the [ending]");
  await expect(
    page.getByText("The footage changed since these captions were made."),
  ).toHaveCount(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export VTT" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("talk.vtt");
  expect(await readFile(await download.path(), "utf8")).toBe(
    [
      "WEBVTT",
      "",
      "00:00:00.500 --> 00:00:02.000",
      "Make &lt;b&gt;ROOM&lt;/b&gt; for this",
      "",
      "00:00:03.000 --> 00:00:04.500",
      "Keep the ending",
      "",
    ].join("\n"),
  );

  await secondCue.click();
  await page
    .locator(".transcript-words button", { hasText: /^words/ })
    .click({ modifiers: ["Shift"] });
  const actions = page.locator(".script-selection-bar");
  await actions.getByRole("button", { name: "Restore", exact: true }).click();
  await shownAt(page, preview, 110, "Remove these [words]");
  await page
    .locator(".edit-picture")
    .screenshot({ path: info.outputPath("after-restore.png") });

  const spoken = page.locator(".transcript-words button");
  await spoken.first().click();
  await spoken.last().click({ modifiers: ["Shift"] });
  await actions.getByRole("button", { name: "Cut", exact: true }).click();
  await expect(preview.locator(".caption-stage")).toHaveCount(1);
  await expect(preview.locator(".caption-group")).toHaveCount(0);
  await page
    .locator(".edit-picture")
    .screenshot({ path: info.outputPath("all-cut.png") });
});

const result = <T>(schema: z.ZodType<T>, value: unknown) => {
  expect(
    z.object({ isError: z.boolean().optional() }).parse(value).isError,
    JSON.stringify(value),
  ).not.toBe(true);
  return z
    .object({ structuredContent: z.object({ result: schema }) })
    .parse(value).structuredContent.result;
};

/** How far red stands above blue in the caption band: the yellow highlight raises it. */
const warmth = async (path: string, frames: number[] = [0]) => {
  const { stdout } = await promisify(execFile)(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      `select=${frames.map((frame) => `eq(n\\,${frame})`).join("+")},${BAND},scale=1:1:flags=area,format=rgb24`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer" },
  );
  return frames.map((_, index) => stdout[index * 3]! - stdout[index * 3 + 2]!);
};

test("an agent's captions render the same in the export as in the preview, and export as SRT", async ({
  baseURL,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const project = await footageProject(request, "Captions by agent");
  const client = new Client({ name: "captions", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: new URL(baseURL!).origin } },
    }),
  );
  try {
    const transcript = result(
      TranscriptViewSchema,
      await client.callTool({
        name: "subtitles_import",
        arguments: {
          projectId: project.id,
          mediaPath: "talk.mp4",
          elementId: "talk",
          format: "srt",
          text: SRT,
        },
      }),
    );
    const captions = result(
      CaptionsViewSchema,
      await client.callTool({
        name: "captions_edit",
        arguments: {
          projectId: project.id,
          edit: {
            action: "generate",
            transcriptId: transcript.id,
            style: "highlight",
          },
        },
      }),
    );
    expect(captions.cues.map((cue) => cue.text)).toEqual([
      "Make room for this",
      "Cut these words",
      "Keep the ending",
    ]);
    const srt = result(
      z.object({ text: z.string() }),
      await client.callTool({
        name: "captions_export",
        arguments: {
          projectId: project.id,
          transcriptId: transcript.id,
          format: "srt",
        },
      }),
    );
    expect(srt.text).toBe(`${SRT.replace("<i>Make room</i>", "Make room")}`);

    const frames = [10, 30, 110, 140, 200];
    const started = result(
      z.object({ jobId: z.string() }),
      await client.callTool({
        name: "export_start",
        arguments: {
          projectId: project.id,
          range: { start: 0, end: 210 },
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
        timeout: 120_000,
        intervals: [250, 500],
      })
      .toBe("complete");
    const exported = await warmth((await status()).outputPath, frames);
    const shown: number[] = [];
    for (const frame of frames) {
      const response = await request.get(
        `/api/projects/${project.id}/thumbnail/index.html?t=${frame / FPS}&format=png&output=source`,
      );
      expect(response.status(), await response.text()).toBe(200);
      const path = testInfo.outputPath(`preview-${frame}.png`);
      await writeFile(path, await response.body());
      shown.push((await warmth(path))[0]!);
    }
    await testInfo.attach("Caption band warmth by frame", {
      body: JSON.stringify({ frames, shown, exported }),
      contentType: "application/json",
    });
    // Before the first cue and after the last, nothing; within a cue, the highlighted word.
    const [before, , , , after] = shown;
    expect(Math.abs(before! - after!)).toBeLessThanOrEqual(2);
    for (const index of [1, 2, 3])
      expect(shown[index]).toBeGreaterThan(before! + 6);
    for (const [index, frame] of frames.entries())
      expect(
        Math.abs(exported[index]! - shown[index]!),
        `frame ${frame}: preview ${shown[index]}, export ${exported[index]}`,
      ).toBeLessThanOrEqual(3);
  } finally {
    await client.close();
  }
});
