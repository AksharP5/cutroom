import { execFile } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import type { CommandInput } from "../src/shared/timeline/schema";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const run = promisify(execFile);

async function seek(page: Page, timecode: string) {
  await page
    .getByRole("button", { name: "Current time. Click to type a time." })
    .click();
  const input = page.getByRole("textbox", { name: "Go to time" });
  await input.pressSequentially(timecode);
  await input.press("Enter");
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
}

async function shownFrame(page: Page, path?: string) {
  const png = await page.locator(".edit-picture").screenshot({ path });
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0))], {
        type: "image/png",
      }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    let number = 0;
    for (let bit = 0; bit < 8; bit++) {
      const [red] = context.getImageData(
        Math.floor(((bit + 0.5) * bitmap.width) / 8),
        Math.floor(bitmap.height / 20),
        1,
        1,
      ).data;
      if (red! > 128) number |= 1 << bit;
    }
    const swatches = [
      [7, 50],
      [68, 65],
      [130, 65],
      [170, 76],
    ].flatMap(([x, y]) =>
      Array.from(
        context.getImageData(
          Math.floor((x! * bitmap.width) / 320),
          Math.floor((y! * bitmap.height) / 180),
          1,
          1,
        ).data,
      ).slice(0, 3),
    );
    return { number, swatches };
  }, png.toString("base64"));
}

test("freeze holds the selected source frame across linked picture and sound, and undo removes it", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Freeze frame evidence" },
      })
    ).json(),
  );
  const bits = Array.from(
    { length: 8 },
    (_, bit) =>
      `drawbox=x=${bit * 40}:y=0:w=40:h=18:color=white:t=fill:enable='eq(mod(floor(n/${2 ** bit})\\,2)\\,1)'`,
  );
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30000/1001:d=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=6",
    "-vf",
    ["drawbox=x=0:y=0:w=320:h=18:color=black:t=fill", ...bits].join(","),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "source.mp4"),
  ]);
  const style =
    "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body style="margin:0"><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="4.004" data-fps="24000/1001">
    <video id="picture" class="clip" src="source.mp4" muted data-link="pair" data-start="0" data-duration="2.5025" data-media-start="0.4004" data-track-index="0" style="${style}"></video>
    <audio id="sound" class="clip" src="source.mp4" data-link="pair" data-start="0" data-duration="2.5025" data-media-start="0.4004" data-track-index="1"></audio>
    <video id="later" class="clip" src="source.mp4" muted data-start="3.003" data-duration="1.001" data-track-index="0" style="${style}"></video>
    <div id="other" class="clip" data-start="3.003" data-duration="1.001" data-track-index="2" style="position:absolute;bottom:0;color:white">Other track</div>
  </main></body></html>`,
  );

  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline;
  const before = await read();
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  const picture = page
    .getByRole("region", { name: "Timeline" })
    .locator('[data-clip="picture"]');
  const menu = page.getByRole("menu", { name: "Clip" });
  const freeze = menu.getByRole("menuitem", { name: "Freeze frame" });
  await picture.click({ button: "right" });
  await expect(freeze).toBeDisabled();
  await page.keyboard.press("Escape");

  await seek(page, "00000101");
  await expect.poll(async () => (await shownFrame(page)).number).toBe(43);
  const source = await shownFrame(page, info.outputPath("before-picture.png"));
  await page.screenshot({ path: info.outputPath("before-editor.png") });
  await picture.click({ button: "right" });
  await freeze.click();
  await expect.poll(async () => (await read()).clips.length).toBe(7);
  const clips = (await read()).clips;
  const still = clips.find((clip) => clip.label === "Freeze")!;
  expect(still).toMatchObject({
    kind: "image",
    start: 25,
    duration: 48,
    track: 0,
    hasAudio: false,
  });
  const asset = join(project.path, still.src!);
  const png = await readFile(asset);
  const exportAsset = join(
    project.path,
    "assets/freeze/export",
    basename(asset),
  );
  const exportPng = await readFile(exportAsset);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(exportPng.subarray(1, 4).toString()).toBe("PNG");
  const tails = clips.filter((clip) => clip.start === 73);
  expect(tails).toHaveLength(2);
  expect(tails[0]).toMatchObject({
    track: 0,
    duration: 35,
    mediaStart: 1.443108,
  });
  expect(tails[1]).toMatchObject({
    track: 1,
    duration: 35,
    mediaStart: 1.443108,
    link: tails[0]!.link,
  });
  expect(tails[0]!.link).not.toBe("pair");
  expect(
    clips
      .filter((clip) => clip.id === "later" || clip.id === "other")
      .map(({ id, start }) => [id, start]),
  ).toEqual([
    ["later", 120],
    ["other", 72],
  ]);

  await seek(page, "00000200");
  await expect.poll(async () => (await shownFrame(page)).number).toBe(43);
  const held = await shownFrame(page, info.outputPath("after-picture.png"));
  const largestColourDelta = Math.max(
    ...source.swatches.map((value, pixel) =>
      Math.abs(value - held.swatches[pixel]!),
    ),
  );
  expect(largestColourDelta).toBeLessThanOrEqual(2);
  await writeFile(
    info.outputPath("preview-frame-43.json"),
    JSON.stringify({ source, held, largestColourDelta }, null, 2),
  );
  await page.screenshot({ path: info.outputPath("after-editor.png") });

  await page.keyboard.press("Control+z");
  await expect.poll(read).toEqual(before);
  await expect
    .poll(() =>
      readFile(asset).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  await expect
    .poll(() =>
      readFile(exportAsset).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await read()).clips).toEqual(clips);
  expect(await readFile(asset)).toEqual(png);
  expect(await readFile(exportAsset)).toEqual(exportPng);
});

async function connectMcp(baseURL: string) {
  const client = new Client({ name: "freeze-e2e", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: new URL(baseURL).origin } },
    }),
  );
  return client;
}

async function mcpTimeline(
  client: Client,
  tool: "timeline_read" | "timeline_edit",
  args: {
    projectId: string;
    expectedRevision?: string;
    commands?: CommandInput[];
  },
) {
  const reply = await client.callTool({
    name: tool,
    arguments: { ...args, fullTimeline: true },
  });
  expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
  return z.object({ result: TimelineViewSchema }).parse(reply.structuredContent)
    .result;
}

async function renderMp4(
  request: APIRequestContext,
  id: string,
  path: string,
  fps?: 25,
) {
  const render = await request.post(`/api/projects/${id}/export`, {
    data: {
      filename: basename(path),
      quality: "draft",
      range: "timeline",
      gpu: false,
      ...(fps ? { fps } : {}),
    },
  });
  expect(render.ok(), await render.text()).toBe(true);
  const { jobId } = await render.json();
  const status = await request.get(`/api/render/${jobId}/progress`);
  const progress = await status.text();
  await writeFile(path + ".progress", progress);
  expect(progress).toContain('"status":"complete"');
  const job = await request.get(`/api/render/${jobId}`);
  const result = await job.json();
  await writeFile(path + ".job.json", JSON.stringify(result, null, 2));
  if (fps) {
    expect(progress).toMatch(/"code":"capture"/);
  } else {
    expect(result.encoder).toBe("libx264");
    expect(progress).not.toMatch(/"code":"capture"/);
  }
  const download = await request.get(`/api/render/${jobId}/download`);
  expect(download.ok()).toBe(true);
  await writeFile(path, await download.body());
}

async function exportedSwatches(path: string, time: number) {
  const { stdout } = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(time),
      "-i",
      path,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  expect(stdout.length).toBe(320 * 180 * 3);
  return [
    [7, 50],
    [68, 65],
    [130, 65],
    [170, 76],
  ].flatMap(([x, y]) => {
    const start = (y! * 320 + x!) * 3;
    return [...stdout.subarray(start, start + 3)];
  });
}

test("original and reused frozen swatches match video in preview and both export paths", async ({
  page,
  request,
  baseURL,
}, info) => {
  test.setTimeout(120_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Freeze export colour" },
      })
    ).json(),
  );
  const sources = [
    ["untagged", null],
    ["bt601", "smpte170m"],
    ["bt709", "bt709"],
  ] as const;
  for (const [name, tag] of sources) {
    const source = join(project.path, name + ".mp4");
    const colour = tag
      ? `,setparams=colorspace=${tag}:color_trc=${tag}:color_primaries=${tag}:range=tv`
      : "";
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x180:r=1:d=1",
      "-vf",
      `loop=loop=3:size=1:start=0,fps=30${colour}`,
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      ...(tag ? ["-movflags", "+write_colr"] : []),
      source,
    ]);
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=color_space,color_transfer,color_primaries",
      "-of",
      "csv=p=0",
      source,
    ]);
    expect(stdout.trim()).toBe(
      Array(3)
        .fill(tag ?? "unknown")
        .join(","),
    );
  }
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}main{position:relative;width:100%;height:100%;overflow:hidden}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="3" data-fps="30">
    ${sources
      .map(
        ([name], i) =>
          `<video id="v${i}" src="${name}.mp4" muted data-start="${i}" data-duration="1" data-media-start="0.5" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"></video>`,
      )
      .join("\n")}
    </main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  const previewReference = [];
  for (const [i, [source]] of sources.entries()) {
    await seek(page, `00000${i}15`);
    previewReference.push(
      await shownFrame(
        page,
        info.outputPath(`preview-${source}-reference.png`),
      ),
    );
  }
  const modes = [
    ["direct", undefined],
    ["capture", 25],
  ] as const;
  for (const [mode, fps] of modes)
    await renderMp4(
      request,
      project.id,
      info.outputPath(`${mode}-reference.mp4`),
      fps,
    );
  const client = await connectMcp(baseURL!);
  try {
    const before = await mcpTimeline(client, "timeline_read", {
      projectId: project.id,
    });
    await mcpTimeline(client, "timeline_edit", {
      projectId: project.id,
      expectedRevision: before.revision,
      commands: sources
        .map<CommandInput>((_, i) => ({
          type: "freeze",
          clipId: `v${i}`,
          id: `still${i}`,
          at: i * 30 + 15,
        }))
        .reverse(),
    });
  } finally {
    await client.close();
  }

  await page.reload();
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  const media = page.getByRole("region", { name: "Media", exact: true });
  const untaggedStill = media
    .getByRole("listitem")
    .filter({ hasText: "still0.png" });
  await expect(untaggedStill).toHaveCount(1);
  await untaggedStill.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await media
    .getByRole("textbox", { name: "Rename still0.png" })
    .fill("hold#2 %23");
  await page.keyboard.press("Enter");
  const renamedStill = media
    .getByRole("listitem")
    .filter({ hasText: "hold#2 %23.png" });
  await expect(renamedStill).toBeVisible();
  await seek(page, "00000108");
  await renamedStill.dblclick();
  await page.keyboard.press("i");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("o");
  await page.keyboard.press("F10");
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline;
  // The 1.5 s swatch below falls inside the Media copy, between pieces of the original freeze.
  await expect
    .poll(async () => (await read()).clips.find(({ start }) => start === 38))
    .toMatchObject({
      src: "assets/freeze/hold%232%20%2523.png",
      duration: 31,
    });
  const reused = (await read()).clips.find(({ start }) => start === 38)!;
  await expect(
    page.locator(`[data-clip-label="${reused.id}"] .tl-name`),
  ).toHaveText("hold#2 %23.png");
  await seek(page, "00000115");
  await page.getByRole("button", { name: "Script", exact: true }).click();
  await page.screenshot({ path: info.outputPath("reused-still-editor.png") });
  const preview = [];
  for (const [i, [source]] of sources.entries()) {
    const expected = previewReference[i]!.swatches;
    const samples = [];
    for (const timecode of [
      `00000${3 * i}07`,
      `00000${3 * i + 1}00`,
      `00000${3 * i + 1}15`,
      `00000${3 * i + 2}23`,
    ]) {
      await seek(page, timecode);
      const { swatches } = await shownFrame(
        page,
        info.outputPath(`preview-${source}-${timecode}.png`),
      );
      samples.push(swatches);
      expect(
        Math.max(
          ...swatches.map((value, channel) =>
            Math.abs(value - expected[channel]!),
          ),
        ),
        `preview ${source} at ${timecode}: ${swatches} vs ${expected}`,
      ).toBeLessThanOrEqual(3);
    }
    preview.push({ source, expected, samples });
  }
  await writeFile(
    info.outputPath("preview-swatches.json"),
    JSON.stringify(preview, null, 2),
  );

  const evidence = [];
  for (const [mode, fps] of modes) {
    const path = info.outputPath(`${mode}-freeze.mp4`);
    const reference = info.outputPath(`${mode}-reference.mp4`);
    await renderMp4(request, project.id, path, fps);
    for (const [i, [source]] of sources.entries()) {
      const expected = await exportedSwatches(reference, i + 0.5);
      const samples = [];
      for (const offset of [0.25, 1, 1.5, 2.75]) {
        const pixels = await exportedSwatches(path, i * 3 + offset);
        samples.push(pixels);
        expect(
          Math.max(
            ...pixels.map((value, channel) =>
              Math.abs(value - expected[channel]!),
            ),
          ),
          `${mode} ${source} at offset ${offset}: ${pixels} vs ${expected}`,
        ).toBeLessThanOrEqual(8);
      }
      evidence.push({ mode, source, expected, samples });
    }
  }
  await writeFile(
    info.outputPath("swatches.json"),
    JSON.stringify(evidence, null, 2),
  );
});

test("an aliased freeze stays visible through Media rename and history, including both export paths", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Freeze alias rename" },
      })
    ).json(),
  );
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=1:d=1",
    "-vf",
    "loop=loop=2:size=1:start=0,fps=30",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    join(project.path, "source.mp4"),
  ]);
  const style =
    "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}main{position:relative;width:100%;height:100%;overflow:hidden}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="2" data-fps="30"><video id="v" src="source.mp4" muted data-start="0" data-duration="2" data-track-index="0" style="${style}"></video></main></body></html>`,
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const timeline = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    );
  const edit = async (commands: CommandInput[]) => {
    const response = await request.post(`${api}/commands`, {
      data: { expectedRevision: (await timeline()).revision, commands },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  await edit([{ type: "freeze", clipId: "v", at: 24, id: "still" }]);
  await symlink("assets/freeze", join(project.path, "alias"));
  await edit([
    {
      type: "insert",
      at: 120,
      track: 0,
      clip: {
        kind: "image",
        src: "alias/still.png",
        id: "directory-alias",
        duration: 30,
      },
    },
    {
      type: "insert",
      at: 150,
      track: 0,
      clip: {
        kind: "image",
        src: "/assets/freeze/still.png",
        id: "absolute",
        duration: 30,
      },
    },
  ]);

  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-ready",
  );
  await seek(page, "00000007");
  const reference = (await shownFrame(page, info.outputPath("source.png")))
    .swatches;
  const samples = async (phase: string) => {
    for (const [id, timecode] of [
      ["directory-alias", "00000415"],
      ["absolute", "00000515"],
    ]) {
      await seek(page, timecode!);
      await expect
        .poll(async () => {
          const { swatches } = await shownFrame(page);
          return Math.max(
            ...swatches.map((value, channel) =>
              Math.abs(value - reference[channel]!),
            ),
          );
        })
        .toBeLessThanOrEqual(3);
      await shownFrame(page, info.outputPath(`${phase}-${id}.png`));
    }
  };
  await samples("before");

  const media = page.getByRole("region", { name: "Media", exact: true });
  await media
    .getByRole("listitem")
    .filter({ hasText: "still.png" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await media
    .getByRole("textbox", { name: "Rename still.png" })
    .fill("hold#2 %23");
  await page.keyboard.press("Enter");
  await expect(
    media.getByRole("listitem").filter({ hasText: "hold#2 %23.png" }),
  ).toBeVisible();
  const aliasSrc = async () =>
    (await timeline()).timeline.clips.find(
      (clip) => clip.id === "directory-alias",
    )?.src;
  const renamed = "alias/hold%232 %2523.png";
  await expect.poll(aliasSrc).toBe(renamed);
  await samples("renamed");

  await page.keyboard.press("Control+z");
  await expect.poll(aliasSrc).toBe("alias/still.png");
  await samples("undone");
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(aliasSrc).toBe(renamed);
  await samples("redone");

  const evidence = [];
  for (const [mode, fps] of [
    ["direct", undefined],
    ["capture", 25],
  ] as const) {
    const output = info.outputPath(`${mode}.mp4`);
    await renderMp4(request, project.id, output, fps);
    const source = await exportedSwatches(output, 0.25);
    for (const time of [4.5, 5.5]) {
      const still = await exportedSwatches(output, time);
      const delta = Math.max(
        ...still.map((value, channel) => Math.abs(value - source[channel]!)),
      );
      expect(delta, `${mode} at ${time}s`).toBeLessThanOrEqual(8);
      evidence.push({ mode, time, source, still, delta });
    }
  }
  await writeFile(
    info.outputPath("swatches.json"),
    JSON.stringify(evidence, null, 2),
  );
});

for (const inbound of [true, false]) {
  test(`MCP writes freeze, keyframe, fade and centered ${inbound ? "incoming" : "outgoing"} dissolve as one edit`, async ({
    page,
    request,
    baseURL,
  }, info) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: "Edited freeze frame" },
        })
      ).json(),
    );
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=lime:s=320x180:r=30:d=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      join(project.path, "source.mp4"),
    ]);
    await writeFile(
      join(project.path, "index.html"),
      '<!doctype html><html><body style="margin:0;background:black"><main id="main" data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="2" data-fps="30"><video id="v" src="source.mp4" muted data-start="0" data-duration="2" data-media-start="0.5" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"></video></main></body></html>',
    );
    const client = await connectMcp(baseURL!);
    try {
      const read = () =>
        mcpTimeline(client, "timeline_read", { projectId: project.id });
      const before = await read();
      const edited = await mcpTimeline(client, "timeline_edit", {
        projectId: project.id,
        expectedRevision: before.revision,
        commands: [
          {
            type: "freeze",
            clipId: "v",
            at: 24,
            id: "still",
            ids: { v: ["tail"] },
          },
          {
            type: "setKeyframe",
            clipId: "still",
            property: "opacity",
            frame: 5,
            value: 0.5,
          },
          {
            type: "setClip",
            clipId: "still",
            ...(inbound ? { fadeOut: 8 } : { fadeIn: 8 }),
          },
          {
            type: "setTransition",
            from: inbound ? "v" : "still",
            to: inbound ? "still" : "tail",
            transition: { duration: 6, alignment: "center" },
            linked: false,
          },
        ],
      });
      const { timeline } = await read();
      expect(timeline).toEqual(edited.timeline);
      const still = timeline.clips.find(({ id }) => id === "still");
      expect(still).toMatchObject({
        start: 24,
        duration: 60,
        keyframes: { opacity: [{ frame: 5, value: 0.5 }] },
        ...(inbound
          ? { fadeOut: 8, transitionIn: { duration: 6, alignment: "center" } }
          : { fadeIn: 8, transitionOut: { duration: 6, alignment: "center" } }),
      });
      const html = await readFile(join(project.path, "index.html"), "utf8");
      await writeFile(info.outputPath("index.html"), html);
      const image = /<img id="still"[^>]*>/.exec(html)?.[0];
      expect(image).toContain(
        inbound ? 'data-start="0.7"' : 'data-start="0.8"',
      );
      expect(image).toContain('data-duration="2.1"');
      expect(image).toContain(`data-fade-${inbound ? "out" : "in"}="0.266667"`);
      expect(image).toContain(
        `data-cutroom-keyframes="opacity ${inbound ? "0.266667" : "0.166667"} 0.5"`,
      );
      expect(image).toContain(
        inbound
          ? 'data-transition-in="dissolve"'
          : 'data-transition-out-under=""',
      );
    } finally {
      await client.close();
    }

    await page.goto(`/#project/${project.id}`);
    await expect(page.locator(".edit-stage")).toHaveAttribute(
      "data-preview-ready",
    );
    await seek(page, "00000115");
    const picture = await shownFrame(
      page,
      info.outputPath("keyframed-hold.png"),
    );
    expect(picture.swatches[1]).toBeGreaterThanOrEqual(117);
    expect(picture.swatches[1]).toBeLessThanOrEqual(135);
  });
}
