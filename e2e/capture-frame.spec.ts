import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Page } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { StillSchema } from "../src/shared/export";
import { ReviewItemSchema } from "../src/shared/review";
import { seekFrame } from "./position-helpers";

const pngSize = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
});

const centerPixel = (page: Page, bytes: Buffer) =>
  page.evaluate(async (encoded) => {
    const png = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([png], { type: "image/png" }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    return [
      ...context.getImageData(bitmap.width / 2, bitmap.height / 2, 1, 1).data,
    ];
  }, bytes.toString("base64"));

test("MCP saves the exact named-scene frame as a PNG without replacing earlier stills", async ({
  page,
  request,
  baseURL,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Frame proof", duration: 1, width: 320, height: 240 },
      })
    ).json(),
  );
  await mkdir(join(project.path, "compositions"));
  const composition = "compositions/frames.html";
  await writeFile(
    join(project.path, composition),
    `<template><main data-composition-id="frames" data-width="320" data-height="240" data-fps="24" data-duration="1"><div id="red" class="clip" data-start="0" data-duration="0.04" data-track-index="0" style="position:absolute;inset:0;background:red"></div><div id="green" class="clip" data-start="0.04" data-duration="0.96" data-track-index="0" style="position:absolute;inset:0;background:lime"></div></main></template>`,
  );
  const index = join(project.path, "index.html");
  const source = (await readFile(index, "utf8")).replace(
    /(<main[^>]*>)[\s\S]*<\/main>/,
    `$1<div id="frames" class="clip" data-composition-id="frames" data-composition-src="${composition}" data-start="0" data-duration="1" data-track-index="0"></div></main>`,
  );
  await writeFile(index, source);
  const http = new Client({ name: "HTTP frame proof", version: "1" });
  const stdio = new Client({ name: "Stdio frame proof", version: "1" });
  try {
    await http.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    await stdio.connect(
      new StdioClientTransport({
        command: "bun",
        args: [
          fileURLToPath(new URL("../src/server/mcp/stdio.ts", import.meta.url)),
        ],
        env: { PATH: process.env.PATH ?? "", CUTROOM_URL: baseURL! },
      }),
    );
    const save = (client: Client, frame: number) =>
      client.callTool({
        name: "export_frame",
        arguments: { projectId: project.id, composition, frame },
      });
    const readStill = async (client: Client) => {
      const reply = await save(client, 1);
      expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
      return z.object({ result: StillSchema }).parse(reply.structuredContent)
        .result;
    };
    const stills = await Promise.all([readStill(http), readStill(stdio)]);
    expect(new Set(stills.map(({ filename }) => filename))).toEqual(
      new Set(["Frame proof 00-00-00-01.png", "Frame proof 00-00-00-01 2.png"]),
    );
    for (const { filename, path } of stills)
      expect(path).toBe(join(project.path, ".cutroom/renders", filename));
    const [first, second] = stills;
    const png = await readFile(first.path);
    expect(pngSize(png)).toEqual({ width: 320, height: 240 });
    expect(await readFile(second.path)).toEqual(png);
    expect(await centerPixel(page, png)).toEqual([0, 255, 0, 255]);
    await writeFile(info.outputPath("mcp-frame.png"), png);
    const outside = await save(http, 24);
    expect(outside.isError).toBe(true);
    expect(outside.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("Choose a frame inside the composition."),
      }),
    ]);
    expect(await readdir(join(project.path, ".cutroom/renders"))).toHaveLength(
      2,
    );
    expect(await readFile(index, "utf8")).toBe(source);
  } finally {
    await Promise.all([http.close(), stdio.close()]);
  }
});

test("stills and notes capture the incoming picture even after a nearby thumbnail is cached", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Exact still", width: 320, height: 240, duration: 1 },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0}.clip{position:absolute;inset:0}</style></head><body><main data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-fps="30" data-duration="1"><div id="outgoing" class="clip" data-start="0" data-duration="0.033333" data-track-index="0" style="background:#ff0000"></div><div id="incoming" class="clip" data-start="0.033333" data-duration="0.966667" data-track-index="0" style="background:#00ff00"></div></main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await seekFrame(page, 1);
  const pixel = (bytes: Buffer) => centerPixel(page, bytes);
  const picture = page.locator(".edit-picture");
  expect(await pixel(await picture.screenshot())).toEqual([0, 255, 0, 255]);
  const nearby = await request.get(
    `/api/projects/${project.id}/thumbnail/index.html?t=0.033&format=png&output=source`,
  );
  expect(nearby.ok()).toBe(true);
  expect(await pixel(await nearby.body())).toEqual([255, 0, 0, 255]);

  const cached = await request.get(
    `/api/projects/${project.id}/thumbnail/index.html?t=0.033&format=png&output=source&cached=1`,
  );
  expect(cached.status()).toBe(200);
  expect(await pixel(await cached.body())).toEqual([255, 0, 0, 255]);

  await page.keyboard.press("Control+Alt+g");
  await expect(
    page.getByText("Saved Exact still 00-00-00-01.png in .cutroom/renders"),
  ).toBeVisible({ timeout: 30_000 });
  const png = await readFile(
    join(project.path, ".cutroom/renders/Exact still 00-00-00-01.png"),
  );
  await writeFile(info.outputPath("saved-frame-1.png"), png);
  expect(await pixel(png)).toEqual([0, 255, 0, 255]);

  await page.getByRole("button", { name: /^Comment/ }).click();
  await page
    .getByLabel("Pin a comment on the composition")
    .click({ position: { x: 36, y: 36 } });
  const note = page.getByLabel("What should change?");
  await note.fill("Stay on this frame");
  await note.press("Enter");
  const readNotes = async () =>
    z
      .object({ items: z.array(ReviewItemSchema) })
      .parse(
        await (
          await request.get(`/api/cutroom/projects/${project.id}/review`)
        ).json(),
      ).items;
  await expect.poll(async () => (await readNotes())[0]?.framePath).toBeTruthy();
  const [saved] = await readNotes();
  expect(saved?.time).toBe(1 / 30);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const image = page.locator(`#review-note-${saved!.id} img`);
  await expect(image).toHaveAttribute("src");
  const frame = await request.get((await image.getAttribute("src"))!);
  expect(frame.ok()).toBe(true);
  expect(await pixel(await frame.body())).toEqual([0, 255, 0, 255]);
});

test("Ctrl+Alt+G and the Export dialog save the playhead's frame as a PNG at the composition's size", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Stills", width: 1280, height: 720 },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("[data-clip]").first()).toBeVisible();
  await page.getByRole("region", { name: "Viewer", exact: true }).click();
  for (let step = 0; step < 15; step++) await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: /^Current time/ }),
  ).toContainText("00:00:00:15");

  await page.keyboard.press("Control+Alt+g");
  await expect(
    page.getByText("Saved Stills 00-00-00-15.png in .cutroom/renders"),
  ).toBeVisible({ timeout: 30_000 });
  const renders = join(project.path, ".cutroom/renders");
  const first = await readFile(join(renders, "Stills 00-00-00-15.png"));
  expect(pngSize(first)).toEqual({ width: 1280, height: 720 });

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "Save frame as PNG" }).click();
  await expect(
    page.getByText("Saved Stills 00-00-00-15 2.png in .cutroom/renders"),
  ).toBeVisible({ timeout: 30_000 });
  expect(
    pngSize(await readFile(join(renders, "Stills 00-00-00-15 2.png"))),
  ).toEqual({ width: 1280, height: 720 });
});
