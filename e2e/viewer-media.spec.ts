import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

async function openMedia(page: Page, request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Razor picture", width: 640, height: 360, duration: 12 },
      })
    ).json(),
  );
  const exec = promisify(execFile);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=640x360:r=30:d=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=12",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "Picture.mp4"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=orange:s=100x60",
    "-frames:v",
    "1",
    join(project.path, "Still.png"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=12",
    join(project.path, "Music.wav"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>
    body{margin:0;background:#101010}main{position:relative;width:640px;height:360px}
    video{position:absolute;inset:0;width:100%;height:100%}img{position:absolute;right:12px;top:12px;width:100px;height:60px}
    </style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-duration="12" data-fps="30">
    <video id="picture" data-start="0" data-duration="12" data-track-index="0" muted data-link="sound" src="Picture.mp4"></video>
    <audio id="sound" data-start="0" data-duration="12" data-track-index="2" data-link="sound" src="Picture.mp4"></audio>
    <img id="still" class="clip" data-start="0" data-duration="12" data-track-index="1" src="Still.png">
    <audio id="music" data-start="0" data-duration="12" data-track-index="3" src="Music.wav"></audio>
    </main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  const seek = async (digits: string) => {
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page.getByLabel("Go to time").pressSequentially(digits);
    await page.keyboard.press("Enter");
  };
  return { project, read, seek };
}

/** Sample actual composited pixels, including the handoff, rather than an iframe's readiness flag. */
async function keepPicture(page: Page, change: () => Promise<unknown>) {
  const before = await page.locator("iframe[data-live]").getAttribute("src");
  const box = (await page.locator(".edit-picture").boundingBox())!;
  const colors: number[][] = [];
  let settled = false;
  const sampling = (async () => {
    const started = Date.now();
    while (!settled || Date.now() - started < 1000) {
      const png = await page.screenshot({
        clip: {
          x: Math.floor(box.x + box.width / 2),
          y: Math.floor(box.y + box.height / 2),
          width: 4,
          height: 4,
        },
      });
      colors.push(
        await page.evaluate(async (bytes) => {
          const image = await createImageBitmap(
            new Blob([new Uint8Array(bytes)], { type: "image/png" }),
          );
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 4;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          image.close();
          return Array.from(context.getImageData(1, 1, 1, 1).data).slice(0, 3);
        }, Array.from(png)),
      );
      await page.waitForTimeout(25);
    }
  })();
  try {
    await change();
    await expect(page.locator("iframe[data-live]")).not.toHaveAttribute(
      "src",
      before!,
    );
    await expect(page.locator(".edit-frame")).toHaveCount(1);
  } finally {
    settled = true;
    await sampling;
  }
  expect(colors.length).toBeGreaterThan(5);
  expect(
    colors.filter(
      ([red, green, blue]) => red! < 230 || green! > 20 || blue! > 20,
    ),
    "Every sample must be the old or new red video frame, never the blank background",
  ).toEqual([]);
  await expect(page.locator(".status-error")).toHaveCount(0);
}

test("razor at fractional-second playheads never blanks the visible picture", async ({
  page,
  request,
}) => {
  const { read, seek } = await openMedia(page, request);
  for (const [digits, count] of [
    ["0103", 8],
    ["0311", 12],
    ["1117", 16],
  ] as const) {
    await seek(digits);
    await keepPicture(page, () => page.keyboard.press("e"));
    await expect
      .poll(async () => (await read()).timeline.clips.length)
      .toBe(count);
  }
});

test("MCP split, undo, redo, ripple deletion and a media drop keep the picture", async ({
  page,
  request,
  baseURL,
}) => {
  const { project, read, seek } = await openMedia(page, request);
  const client = new Client({ name: "viewer-media-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: new URL(baseURL!).origin } },
    }),
  );
  try {
    await seek("0311");
    const { revision } = await read();
    await keepPicture(page, async () => {
      const result = await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: revision,
          label: "Split picture",
          commands: [{ type: "split", at: 101, clipIds: ["picture"] }],
        },
      });
      expect(result.isError).not.toBe(true);
    });
    await keepPicture(page, () => page.keyboard.press("Control+z"));
    await keepPicture(page, () => page.keyboard.press("Control+Shift+z"));
    await page.locator('[data-clip="picture"]').click();
    await keepPicture(page, () => page.keyboard.press("Shift+X"));

    // Cutroom has no paste command yet. Insert a copy through the shared media
    // command to cover the new-element path a paste would use.
    await seek("0311");
    const current = await read();
    await keepPicture(page, async () => {
      const result = await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: current.revision,
          label: "Insert copied picture",
          commands: [
            {
              type: "insert",
              mode: "overwrite",
              track: 0,
              at: 101,
              clip: { kind: "video", src: "Picture.mp4", duration: 30 },
            },
          ],
        },
      });
      expect(result.isError).not.toBe(true);
    });

    // Drop at the playhead on V1, replacing the piece there with a fresh video element.
    const picture = (await read()).timeline.clips.find(
      (clip) => clip.kind === "video",
    )!;
    const clip = page.locator(`[data-clip="${picture.id}"]`);
    const bounds = (await clip.boundingBox())!;
    const playhead = (await page
      .locator(".tl-playhead")
      .first()
      .boundingBox())!;
    const row = page
      .getByRole("region", { name: "Media", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "Picture.mp4" });
    await keepPicture(page, async () => {
      await row.hover();
      await page.mouse.down();
      await page.mouse.move(playhead.x, bounds.y + bounds.height / 2, {
        steps: 12,
      });
      await page.mouse.move(playhead.x, bounds.y + bounds.height / 2);
      await expect(page.locator(".tl-ghost")).toBeVisible();
      await page.mouse.up();
    });
  } finally {
    await client.close();
  }
});
