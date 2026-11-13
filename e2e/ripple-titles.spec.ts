import { execFile } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

test("ripple delete and Q/W keep a title editable as one attributed clip, with MCP parity and one-step undo", async ({
  page,
  request,
  baseURL,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Ripple under a lower third",
          width: 640,
          height: 360,
          duration: 6,
        },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30:d=6",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    join(project.path, "picture.mp4"),
  ]);
  await copyFile(
    join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
    join(project.path, "gsap.min.js"),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xd9b650:s=64x64",
    "-frames:v",
    "1",
    join(project.path, "still.png"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0}video{position:absolute;width:640px;height:360px}.lower{position:absolute;left:40px;top:260px;color:white;background:#151515;padding:16px;font:24px sans-serif}img{position:absolute;left:550px;top:30px}</style><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="6"><video id="first" src="picture.mp4" muted data-start="0" data-duration="2" data-track-index="0"></video><video id="shot" src="picture.mp4" muted data-start="2" data-duration="1" data-media-start="2" data-track-index="0"></video><video id="last" src="picture.mp4" muted data-start="3" data-duration="3" data-media-start="3" data-track-index="0"></video><div id="lower" class="clip lower" data-label="Lower third" data-start="1" data-duration="4" data-track-index="1">Grace Hopper</div><img id="still" src="still.png" data-start="0" data-duration="6" data-track-index="2"></main><script>window.__timelines.main=gsap.timeline({paused:true}).fromTo('.lower',{opacity:0},{opacity:1,duration:.5},1);</script></body></html>`,
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  const client = new Client({ name: "ripple-title-proof", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const initial = await read();
    const attributed = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: initial.revision,
        commands: [
          {
            type: "setClip",
            clipId: "lower",
            text: "Grace Hopper, Rear Admiral",
          },
        ],
      },
    });
    expect(attributed.isError).not.toBe(true);
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator('[data-clip="lower"]')).toBeVisible();
    await expect(page.locator('[data-agent-change="lower"]')).toBeVisible();
    const before = await read();
    const seek = async () => {
      await page.getByRole("button", { name: /^Current time/ }).click();
      await page.getByLabel("Go to time").pressSequentially("0215");
      await page.keyboard.press("Enter");
    };
    for (const [key, duration] of [
      ["Shift+x", 90],
      ["q", 105],
      ["w", 105],
    ] as const) {
      await seek();
      await page.locator('[data-clip="shot"]').click();
      await page.keyboard.press(key);
      await expect
        .poll(async () => (await read()).revision)
        .not.toBe(before.revision);
      await expect(page.locator(".tl-lanes")).not.toHaveAttribute(
        "data-sliding",
      );
      await expect(page.locator("[data-preview-ready]")).toHaveAttribute(
        "data-preview-ready",
      );
      await page.screenshot({
        path: info.outputPath(`${key.replace("+", "-")}.png`),
      });
      await expect(page.locator('[data-clip^="lower"]')).toHaveCount(1);
      await expect(page.locator('[data-clip^="still"]')).toHaveCount(1);
      const after = await read();
      expect(
        after.timeline.clips.find((clip) => clip.id === "lower"),
      ).toMatchObject({
        start: 30,
        duration,
        text: "Grace Hopper, Rear Admiral",
      });
      expect(after.agentChanges).toContain("lower");
      await expect(page.locator('[data-agent-change="lower"]')).toBeVisible();
      await page.keyboard.press("Control+z");
      await expect
        .poll(async () => (await read()).timeline)
        .toEqual(before.timeline);
    }
    const current = await read();
    const edited = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: current.revision,
        commands: [{ type: "remove", clipIds: ["shot"], ripple: true }],
      },
    });
    expect(edited.isError).not.toBe(true);
    await expect(page.locator('[data-clip="shot"]')).toHaveCount(0);
    await expect(page.locator('[data-clip^="lower"]')).toHaveCount(1);
    await page.locator('[data-clip="lower"]').click();
    await page
      .getByLabel("Text", { exact: true })
      .fill("One title, still editable");
    await page.getByLabel("Text", { exact: true }).press("Tab");
    await expect
      .poll(
        async () =>
          (await read()).timeline.clips.find((clip) => clip.id === "lower")
            ?.text,
      )
      .toBe("One title, still editable");
    await expect(
      page.frameLocator("iframe[data-live]").locator("#lower"),
    ).toHaveText("One title, still editable");
    await page.keyboard.press("Escape");
    await page.locator(".tl-grid").click({ position: { x: 10, y: 10 } });
    await page.keyboard.press("Control+z");
    await expect
      .poll(
        async () =>
          (await read()).timeline.clips.find((clip) => clip.id === "lower")
            ?.text,
      )
      .toBe("Grace Hopper, Rear Admiral");
    await page.keyboard.press("Control+z");
    await expect
      .poll(async () => (await read()).timeline)
      .toEqual(before.timeline);
  } finally {
    await client.close();
  }
});

test("a shortened linked title still moves both audio pieces after ripple, undo and redo", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Linked title ripple",
          width: 640,
          height: 360,
          duration: 10,
        },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=8",
    join(project.path, "sound.wav"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>body{background:#123;color:white}.clip{position:absolute;top:200px;left:20px;font:30px sans-serif}#shot{top:20px}</style></head><body><main data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="10"><div id="shot" class="clip" data-label="Removed shot" data-start="2" data-duration="2" data-track-index="0">Removed shot</div><div id="lower" class="clip" data-label="Linked lower third" data-start="0" data-duration="8" data-track-index="1" data-link="pair">Linked lower third</div><audio id="sound" src="sound.wav" muted data-start="0" data-duration="8" data-track-index="2" data-link="pair"></audio></main></body></html>`,
  );
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="lower"]')).toBeVisible();
  const before = await read();
  await page.locator('[data-clip="shot"]').click();
  await page.keyboard.press("Delete");
  await expect(page.locator('[data-clip="shot"]')).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await read()).timeline)
    .toEqual(before.timeline);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator('[data-clip="shot"]')).toHaveCount(0);
  await expect(page.locator('[data-clip^="lower"]')).toHaveCount(1);
  expect(
    (await read()).timeline.clips.find((clip) => clip.id === "lower")?.duration,
  ).toBe(180);
  await page.locator('[data-clip="lower"]').click();
  await page.getByRole("textbox", { name: "Start", exact: true }).fill("1f");
  await page
    .getByRole("textbox", { name: "Start", exact: true })
    .press("Enter");
  await expect
    .poll(async () =>
      (await read()).timeline.clips
        .filter((clip) => clip.kind === "audio")
        .map((clip) => [clip.start, clip.duration]),
    )
    .toEqual([
      [1, 60],
      [61, 120],
    ]);
  await page.screenshot({
    path: info.outputPath("linked-title-after-move.png"),
  });
});
