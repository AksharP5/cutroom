import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { APIRequestContext } from "@playwright/test";
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";

import type { CommandInput } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

const points = [
  { t: 0, v: 0.5 },
  { t: 4, v: 2 },
];
const html = `<!doctype html><html><head><style>html,body{margin:0}video{position:absolute;width:320px;height:240px}</style></head><body><main data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="8">
<video id="lead" src="pictures.mp4" muted data-start="0" data-duration="2" data-media-start="1" data-track-index="0"></video>
<video id="ramp" src="pictures.mp4" muted data-start="2" data-duration="5" data-media-start="2" data-track-index="0" data-automation='${JSON.stringify({ version: 1, lanes: [{ target: "rate", points }] })}'></video>
</main></body></html>`;

const dissolve = {
  type: "setTransition",
  from: "lead",
  to: "ramp",
  transition: { duration: 10 },
} satisfies CommandInput;
const split = {
  type: "split",
  at: 120,
  clipIds: ["ramp"],
  ids: { ramp: ["tail"] },
} satisfies CommandInput;
const trim = {
  type: "trim",
  clipId: "ramp",
  edge: "end",
  to: 180,
} satisfies CommandInput;

async function fixture(request: APIRequestContext, name: string) {
  const response = await request.post("/api/cutroom/projects", {
    data: { name, width: 320, height: 240, duration: 8 },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const project = ProjectSchema.parse(await response.json());
  const file = join(project.path, "index.html");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x240:r=30:d=12",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-threads",
    "1",
    join(project.path, "pictures.mp4"),
  ]);
  await writeFile(file, html);
  return { project, source: () => readFile(file, "utf8") };
}

const reply = z.object({
  structuredContent: z.object({
    result: z.object({
      revision: z.string(),
      timeline: z.object({
        clips: z.array(
          z.object({
            id: z.string(),
            mediaStart: z.number().nullable(),
            automation: z
              .object({ lanes: z.array(z.string()).optional() })
              .nullable(),
          }),
        ),
      }),
    }),
  }),
});

async function connect(baseURL: string) {
  const client = new Client({ name: "ramp-cut-tests", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: baseURL } },
    }),
  );
  return client;
}

async function edit(
  client: Client,
  projectId: string,
  commands: CommandInput[],
) {
  const read = await client.callTool({
    name: "timeline_read",
    arguments: { projectId },
  });
  const { revision } = reply.parse(read).structuredContent.result;
  const result = await client.callTool({
    name: "timeline_edit",
    arguments: {
      commands,
      projectId,
      expectedRevision: revision,
      fullTimeline: true,
    },
  });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return reply.parse(result).structuredContent.result.timeline;
}

// Byte equality covers on-grid inputs. Writing an intermediate edit can move
// an off-grid neighbour onto the frame grid and change the next request's tail edge.
for (const [name, commands] of [
  ["E1 dissolve then split", [dissolve, split]],
  ["E2 split then dissolve", [split, dissolve]],
  ["E2 dissolve then trim then split", [dissolve, trim, split]],
  [
    "E2 split then trim then dissolve",
    [split, { ...trim, clipId: "tail" }, dissolve],
  ],
] as const) {
  test(`${name} writes identical HTML in a batch and as separate MCP calls`, async ({
    request,
    baseURL,
  }) => {
    const [batch, single] = await Promise.all([
      fixture(request, name + " batch"),
      fixture(request, name + " single"),
    ]);
    const client = await connect(baseURL!);
    try {
      const timeline = await edit(client, batch.project.id, [...commands]);
      for (const command of commands)
        await edit(client, single.project.id, [command]);
      expect(await batch.source()).toBe(await single.source());
      const tail = timeline.clips.find(({ id }) => id === "tail");
      expect(tail?.mediaStart).toBe(3.442795);
      expect(tail?.automation?.lanes).toContain("rate");
      expect(await batch.source()).toContain('"offset":2');
    } finally {
      await client.close();
    }
  });
}

test("E3–E4: MCP undo and redo restore each session edit byte for byte", async ({
  page,
  request,
  baseURL,
}) => {
  const { project, source } = await fixture(request, "Ramp history");
  const client = await connect(baseURL!);
  const snapshots = [await source()];
  const trims = [
    { ...trim, clipId: "tail", to: 206 },
    { ...trim, clipId: "tail", to: 202 },
    { ...trim, clipId: "tail", to: 200 },
  ];
  try {
    for (const command of [split, dissolve, ...trims]) {
      await edit(client, project.id, [command]);
      snapshots.push(await source());
    }
    const step = async (direction: "undo" | "redo") => {
      const result = await client.callTool({
        name: `history_${direction}`,
        arguments: { projectId: project.id },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    };
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator('[data-clip="tail"]')).toBeVisible();
    for (const bytes of snapshots.slice(0, -1).reverse()) {
      await step("undo");
      await expect.poll(source).toBe(bytes);
    }
    await expect(page.locator('[data-clip="tail"]')).toHaveCount(0);
    for (const bytes of snapshots.slice(1)) {
      await step("redo");
      await expect.poll(source).toBe(bytes);
    }
    await expect(page.locator('[data-clip="tail"]')).toBeVisible();
  } finally {
    await client.close();
  }
});

test("a saved ramp tail plays its shifted curve in Cutroom and opens in stock HyperFrames", async ({
  browser,
  page,
  request,
  baseURL,
}) => {
  const { project, source } = await fixture(request, "Ramp playback");
  const client = await connect(baseURL!);
  try {
    await edit(client, project.id, [split]);
  } finally {
    await client.close();
  }

  // Frame 150 is a second into the tail. The source is past 4.63 s on the original
  // curve, but before 4.06 s when stock HyperFrames restarts it at 0.5×.
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="tail"]')).toBeVisible();
  await seekFrame(page, 150);
  const tail = page.frameLocator("iframe[data-live]").locator("video#tail");
  await expect
    .poll(() => tail.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(4.638, 2);

  const stock = await browser.newPage();
  try {
    const document = (await source()).replace(
      "</body>",
      '<script src="/gsap.min.js"></script><script>window.__timelines={main:gsap.timeline({paused:true}).to({}, {duration:8})};</script><script src="/runtime.js"></script></body>',
    );
    const media = await readFile(join(project.path, "pictures.mp4"));
    await stock.route("http://cutroom-stock.test/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/index.html")
        return route.fulfill({ contentType: "text/html", body: document });
      if (pathname === "/runtime.js")
        return route.fulfill({
          contentType: "text/javascript",
          body: getHyperframeRuntimeScript(),
        });
      if (pathname === "/gsap.min.js")
        return route.fulfill({
          path: new URL(import.meta.resolve("gsap/dist/gsap.min.js")).pathname,
        });
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range);
      if (!range)
        return route.fulfill({ contentType: "video/mp4", body: media });
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : media.length - 1;
      return route.fulfill({
        status: 206,
        contentType: "video/mp4",
        headers: { "content-range": `bytes ${start}-${end}/${media.length}` },
        body: media.subarray(start, end + 1),
      });
    });
    await stock.goto("http://cutroom-stock.test/index.html");
    const seek = (frame: number) =>
      stock.evaluate((seconds) => {
        const player = (
          window as Window & { __player?: { seek(at: number): void } }
        ).__player;
        if (!player) throw new Error("Stock HyperFrames did not start.");
        player.seek(seconds);
      }, frame / 30);
    await stock.waitForFunction(() => "__player" in window);
    const video = stock.locator("video#tail");
    await seek(120);
    await expect
      .poll(() =>
        video.evaluate((element: HTMLVideoElement) => element.currentTime),
      )
      .toBeCloseTo(3.443, 2);
    await expect(video).toBeVisible();
    await seek(150);
    await expect
      .poll(() =>
        video.evaluate((element: HTMLVideoElement) => element.currentTime),
      )
      .toBeCloseTo(4.04, 1);
    await seek(211);
    await expect(video).toBeHidden();
  } finally {
    await stock.close();
  }
});
