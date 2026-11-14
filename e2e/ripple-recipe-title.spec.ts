import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { ExportJobSchema } from "../src/shared/export";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);

test("ripple delete keeps the documented title recipe whole in preview and export, with links, attribution, undo and MCP parity", async ({
  page,
  request,
  baseURL,
}, info) => {
  test.setTimeout(120_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Ripple under a recipe title", duration: 8 },
      })
    ).json(),
  );
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x132437:s=320x180:r=30:d=8",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=8",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "interview.mp4"),
  ]);
  const docs = await readFile(
    new URL("../docs/mcp.md", import.meta.url),
    "utf8",
  );
  const recipe = docs
    .split("### Animated titles")[1]!
    .split("```html")
    .slice(1, 3)
    .map((block) => block.split("```")[0]!.trim());
  await mkdir(join(project.path, "compositions"));
  await writeFile(join(project.path, "compositions/lower.html"), recipe[1]!);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#132437;color:white}video{position:absolute;width:1920px;height:1080px}.late{position:absolute;top:800px}</style><script src="assets/vendor/gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="8">
<video id="first" src="interview.mp4" muted data-start="0" data-duration="2" data-track-index="0"></video>
<video id="shot" src="interview.mp4" muted data-start="2" data-duration="1" data-media-start="2" data-track-index="0"></video>
<video id="last" src="interview.mp4" muted data-start="3" data-duration="5" data-media-start="3" data-track-index="0"></video>
${recipe[0]!.replace('data-start="6"', 'data-start="1"').replace('data-track-index="2"', 'data-track-index="1"').replace('class="clip"', 'class="clip" data-link="pair"')}
<audio id="sound" src="interview.mp4" data-start="0" data-duration="8" data-track-index="2" data-link="pair"></audio>
<div id="later" class="clip late" data-label="Later title" data-start="7" data-duration="1" data-track-index="3">Later title</div>
</main><script>window.__timelines ??= {};window.__timelines.main=gsap.timeline({paused:true}).fromTo('#later',{opacity:0},{opacity:1,duration:.2},7);</script></body></html>`,
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  const client = new Client({ name: "recipe-ripple-proof", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  try {
    const initial = await read();
    expect(
      (
        await client.callTool({
          name: "timeline_edit",
          arguments: {
            projectId: project.id,
            expectedRevision: initial.revision,
            commands: [
              { type: "setClip", clipId: "lower", label: "Recipe lower third" },
            ],
          },
        })
      ).isError,
    ).not.toBe(true);
    const before = await read();
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator('[data-clip="shot"]')).toBeVisible();
    await page.locator('[data-clip="shot"]').click();
    await page.keyboard.press("Delete");
    await expect(page.locator('[data-clip="shot"]')).toHaveCount(0);
    const cut = await read();
    await expect(page.locator(".toast")).toContainText(
      "Later title's animation stayed behind.",
    );
    await expect(page.locator(".toast")).not.toContainText(
      "Recipe lower third",
    );
    const seek = async (frame: number) => {
      await page.getByRole("button", { name: /^Current time/ }).click();
      await page
        .getByLabel("Go to time")
        .pressSequentially(
          `0000${String(Math.floor(frame / 30)).padStart(2, "0")}${String(frame % 30).padStart(2, "0")}`,
        );
      await page.keyboard.press("Enter");
    };
    const preview = page.frameLocator("iframe[data-live]");
    const states = [];
    for (const frame of [54, 59, 61]) {
      await seek(frame);
      await expect(preview.locator("#lower-text").first()).toBeAttached();
      states.push(
        await preview
          .locator("#lower-text")
          .first()
          .evaluate((text) => Number(getComputedStyle(text).opacity)),
      );
      await page.screenshot({ path: info.outputPath(`editor-${frame}.png`) });
    }
    const started = await request.post(`/api/projects/${project.id}/export`, {
      data: { range: { start: 54, end: 66 }, quality: "high" },
    });
    expect(started.ok(), await started.text()).toBe(true);
    const { jobId } = z
      .object({ jobId: z.string() })
      .parse(await started.json());
    const status = async () =>
      ExportJobSchema.parse(
        await (await request.get(`/api/render/${jobId}`)).json(),
      );
    await expect
      .poll(async () => (await status()).status, { timeout: 60_000 })
      .not.toBe("rendering");
    const done = await status();
    expect(done.status, done.error ?? "Export did not complete").toBe(
      "complete",
    );
    await exec("ffmpeg", [
      "-v",
      "error",
      "-i",
      done.outputPath,
      "-vf",
      "select=eq(n\\,5)",
      "-frames:v",
      "1",
      info.outputPath("export-before-cut.png"),
    ]);
    const pixels = await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        done.outputPath,
        "-vf",
        "select=eq(n\\,0)+eq(n\\,5)+eq(n\\,7),crop=1200:55:60:600,scale=1:1,format=gray",
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "-",
      ],
      { encoding: "buffer" },
    );
    await writeFile(
      info.outputPath("continuity.json"),
      JSON.stringify(
        {
          previewOpacity: states,
          exportLuminance: [...pixels.stdout],
          titleClips: cut.timeline.clips
            .filter((c) => c.kind === "composition")
            .map((c) => [c.id, c.start, c.duration, c.mediaStart]),
        },
        null,
        2,
      ),
    );
    await expect(page.locator('[data-clip^="lower"]')).toHaveCount(1);
    expect(states).toEqual([1, 1, 1]);
    expect([...pixels.stdout]).toHaveLength(3);
    expect(Math.min(...pixels.stdout)).toBeGreaterThan(30);
    expect(
      Math.max(...pixels.stdout) - Math.min(...pixels.stdout),
    ).toBeLessThan(3);
    expect(cut.timeline.clips.find((c) => c.id === "lower")).toMatchObject({
      start: 30,
      duration: 150,
      mediaStart: 0,
      src: "compositions/lower.html",
    });
    expect(cut.agentChanges).toContain("lower");
    expect(
      await readFile(join(project.path, "compositions/lower.html"), "utf8"),
    ).toBe(recipe[1]);
    await page.keyboard.press("Control+z");
    await expect
      .poll(async () => (await read()).timeline)
      .toEqual(before.timeline);
    await page.keyboard.press("Control+Shift+z");
    await expect
      .poll(async () => (await read()).timeline)
      .toEqual(cut.timeline);
    const current = await read();
    const moved = await request.post(`${api}/commands`, {
      data: {
        expectedRevision: current.revision,
        commands: [{ type: "move", clipIds: ["lower"], by: 1, mode: "place" }],
      },
    });
    expect(moved.ok()).toBe(true);
    expect(
      (await read()).timeline.clips
        .filter((c) => c.kind === "audio")
        .map((c) => [c.start, c.duration]),
    ).toEqual([
      [1, 60],
      [61, 150],
    ]);
    await page.keyboard.press("Control+z");
    await expect
      .poll(async () => (await read()).timeline)
      .toEqual(cut.timeline);
    await page.keyboard.press("Control+z");
    await expect
      .poll(async () => (await read()).timeline)
      .toEqual(before.timeline);
    expect(
      (
        await client.callTool({
          name: "timeline_edit",
          arguments: {
            projectId: project.id,
            expectedRevision: (await read()).revision,
            commands: [{ type: "remove", clipIds: ["shot"], ripple: true }],
          },
        })
      ).isError,
    ).not.toBe(true);
    const parity = (view: z.infer<typeof TimelineViewSchema>) => {
      const lower = view.timeline.clips.find((c) => c.id === "lower")!;
      return view.timeline.clips.map((c) => [
        c.kind,
        c.track,
        c.start,
        c.duration,
        c.mediaStart,
        c.src,
        c.link !== null && c.link === lower.link,
      ]);
    };
    await expect.poll(async () => parity(await read())).toEqual(parity(cut));
  } finally {
    await client.close();
  }
});
