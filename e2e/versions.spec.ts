import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { ExportJobSchema } from "../src/shared/export";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";

const result = <T>(schema: z.ZodType<T>, value: unknown) => {
  expect(
    z.object({ isError: z.boolean().optional() }).parse(value).isError,
    JSON.stringify(value),
  ).not.toBe(true);
  return z
    .object({ structuredContent: z.object({ result: schema }) })
    .parse(value).structuredContent.result;
};

/** Four takes on one line, each a scene with its own colour and motion. */
const TAKES = [
  { name: "Card fan", word: "fan", rgb: [224, 68, 62] },
  { name: "Clip wall", word: "wall", rgb: [62, 196, 109] },
  { name: "Carousel", word: "carousel", rgb: [62, 123, 224] },
  { name: "Orbit", word: "orbit", rgb: [224, 195, 62] },
] as const;
const hex = (rgb: readonly number[]) =>
  `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
const scene = (word: string, rgb: readonly number[]) => `<template>
  <div id="${word}-root" data-composition-id="line-${word}" data-width="1920" data-height="1080" data-duration="3">
    <div id="${word}-box" style="position:absolute;left:760px;top:340px;width:400px;height:400px;background:${hex(rgb)}"></div>
  </div>
  <script>
    {
      const tl = gsap.timeline({ paused: true });
      tl.from("#${word}-box", { y: 200, duration: 1 }, 0);
      window.__timelines ??= {};
      window.__timelines["line-${word}"] = tl;
    }
  </script>
</template>
`;

/**
 * Times from the pointer reaching a row to the preview confirming it shows that version, which
 * it answers after its next frame.
 */
async function timeSwitch(page: Page, row: string) {
  await page.evaluate((row) => {
    const state = window as unknown as { switched?: Promise<number> };
    state.switched = new Promise((resolve) => {
      let start = 0;
      const enter = (event: Event) => {
        const target = event.target as Element | null;
        if (
          !target
            ?.closest(`[role="menuitemradio"]`)
            ?.textContent?.startsWith(row)
        )
          return;
        start = event.timeStamp;
        document.removeEventListener("pointerover", enter, true);
      };
      const listen = (event: MessageEvent) => {
        if (!start || event.data?.source !== "cutroom-audition") return;
        window.removeEventListener("message", listen);
        resolve(performance.now() - start);
      };
      document.addEventListener("pointerover", enter, true);
      window.addEventListener("message", listen);
    });
  }, row);
  await page.getByRole("menuitemradio", { name: row }).hover();
  return page.evaluate(
    () => (window as unknown as { switched: Promise<number> }).switched,
  );
}

test("an agent's four takes on one clip: hover plays each, a click switches, keep drops the rest, and export draws only the active one", async ({
  page,
  baseURL,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const client = new Client({ name: "versions", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: new URL(baseURL!).origin } },
    }),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  try {
    const project = result(
      ProjectSchema,
      await call("project_create", { name: "Versions", duration: 12 }),
    );
    const projectId = project.id;
    const read = async () =>
      TimelineViewSchema.parse(
        await (
          await request.get(`/api/cutroom/projects/${projectId}/timeline`)
        ).json(),
      ).timeline;
    for (const { word, rgb } of TAKES)
      result(
        z.unknown(),
        await call("source_write", {
          projectId,
          path: `compositions/line-${word}.html`,
          expectedVersion: null,
          content: scene(word, rgb),
        }),
      );
    const before = result(
      z.object({ revision: z.string() }),
      await call("timeline_read", { projectId }),
    );
    result(
      z.unknown(),
      await call("timeline_edit", {
        projectId,
        expectedRevision: before.revision,
        commands: [
          {
            type: "insert",
            track: 3,
            at: 60,
            clip: {
              kind: "title",
              id: "line",
              text: "Welcome back",
              duration: 90,
            },
          },
        ],
      }),
    );
    const { clipId } = result(
      z.object({ clipId: z.string() }),
      await call("clip_versions_set", {
        projectId,
        clipId: "line",
        versions: TAKES.map(({ name, word }) => ({
          name,
          src: `compositions/line-${word}.html`,
        })),
      }),
    );

    await page.goto(`/#project/${projectId}`);
    const badge = page.locator(`[data-clip-label="${clipId}"] .tl-versions`);
    await expect(badge).toHaveText("4");
    await seekFrame(page, 100);
    const stage = page.locator(".edit-stage");
    const preview = page.frameLocator("iframe[data-live]");
    const plain = await stage.screenshot();

    // Opening the list loads every take behind the picture, which does not change.
    await badge.click();
    const menu = page.getByRole("menu", { name: "Versions of Welcome back" });
    await expect(menu).toBeVisible();
    await expect(
      page.getByRole("menuitemradio", { name: "Card fan" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(preview.locator("[data-cutroom-version]")).toHaveCount(4);
    await expect(preview.locator("#orbit-box")).toHaveCount(1);
    expect(await stage.screenshot()).toEqual(plain);

    // Hovering a take plays the clip in a loop showing it, within a frame or two.
    const times: number[] = [];
    for (const { name, word } of [...TAKES].reverse()) {
      times.push(await timeSwitch(page, name));
      await expect(preview.locator(`#${word}-box`)).toBeVisible();
    }
    console.log("hover to picture (ms)", JSON.stringify(times));
    await testInfo.attach("hover to picture (ms)", {
      body: JSON.stringify(times),
      contentType: "application/json",
    });
    expect(Math.max(...times)).toBeLessThan(100);
    const playing = page.getByRole("button", {
      name: "Play forward",
      exact: true,
    });
    await expect(playing).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("menuitemradio", { name: "Orbit" }).hover();
    await expect(preview.locator("#orbit-box")).toBeVisible();
    await expect(preview.locator("#fan-box")).toBeHidden();

    // A click makes it the clip's version as one undo step.
    await page.getByRole("menuitemradio", { name: "Orbit" }).click();
    await expect(
      page.getByRole("menuitemradio", { name: "Orbit" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await read()).clips.find((c) => c.id === clipId)?.src)
      .toBe("compositions/line-orbit.html");

    // Leaving the list stops and returns the playhead; the picture shows the new choice.
    await page.mouse.move(5, 5);
    await expect(playing).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect
      .poll(async () => (await read()).clips.find((c) => c.id === clipId)?.src)
      .toBe("compositions/line-fan.html");

    // Alt+V shows the next take of the clip under the playhead.
    await page.locator(`[data-clip="${clipId}"]`).click();
    await seekFrame(page, 100);
    await page.keyboard.press("Alt+V");
    await expect
      .poll(async () => (await read()).clips.find((c) => c.id === clipId)?.src)
      .toBe("compositions/line-wall.html");
    await expect(preview.locator("#wall-box")).toBeVisible();

    // Keep ends the choice: one take is left and the count goes away.
    await badge.click();
    await page.getByRole("button", { name: "Keep Clip wall" }).click();
    await expect(badge).toHaveCount(0);
    const kept = (await read()).clips.find((c) => c.id === clipId);
    expect(kept?.versions).toBeUndefined();
    expect(kept?.src).toBe("compositions/line-wall.html");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(badge).toHaveText("4");

    // Export draws the active take alone.
    const started = result(
      z.object({ jobId: z.string() }),
      await call("export_start", {
        projectId,
        range: { start: 90, end: 96 },
        gpu: false,
      }),
    );
    const status = async () =>
      result(ExportJobSchema, await call("export_status", started));
    await expect
      .poll(
        async () => {
          const job = await status();
          return job.status === "failed" ? JSON.stringify(job) : job.status;
        },
        { timeout: 90_000, intervals: [250, 500] },
      )
      .toBe("complete");
    const centre = await promisify(execFile)(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        (await status()).outputPath,
        "-vf",
        "select=eq(n\\,0),crop=40:40:940:520,scale=1:1:flags=area,format=rgb24",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ],
      { encoding: "buffer" },
    );
    const [r = 0, g = 0, b = 0] = [...centre.stdout];
    const nearest = TAKES.toSorted(
      (one, other) =>
        Math.hypot(one.rgb[0] - r, one.rgb[1] - g, one.rgb[2] - b) -
        Math.hypot(other.rgb[0] - r, other.rgb[1] - g, other.rgb[2] - b),
    )[0];
    expect(nearest?.name).toBe("Clip wall");
  } finally {
    await client.close();
  }
});
