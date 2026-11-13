import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

async function open(
  page: Page,
  request: APIRequestContext,
  label = false,
  count = 1,
  overlap = false,
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Animation feedback" },
      })
    ).json(),
  );
  const path = join(project.path, "index.html");
  let html = await readFile(
    new URL("./fixtures/animation-feedback/index.html", import.meta.url),
    "utf8",
  );
  if (label)
    html = html
      .replace('tl.fromTo("#cta"', 'tl.addLabel("cta",36);\ntl.fromTo("#cta"')
      .replace("duration: 0.5 }, 36)", 'duration: 0.5 }, "cta")');
  if (count > 1) {
    const extras = Array.from(
      { length: count - 1 },
      (_, index) =>
        `<div id="extra-${index}" class="clip" data-start="36" data-duration="4" data-track-index="${index + 3}">Extra ${index}</div>`,
    ).join("");
    const tweens = Array.from(
      { length: count - 1 },
      (_, index) => `tl.to("#extra-${index}",{opacity:1,duration:.5},"cta");`,
    ).join("\n");
    html = html
      .replace("</main>", `${extras}</main>`)
      .replace(
        'window.__timelines["main"]',
        `${tweens}\nwindow.__timelines["main"]`,
      );
  }
  if (overlap)
    html = (
      await readFile(
        new URL("./fixtures/animation-feedback/overlap.html", import.meta.url),
        "utf8",
      )
    ).replace(/id="shot"/g, 'id="intro"');
  await writeFile(path, html);
  await copyFile(
    join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
    join(project.path, "gsap.min.js"),
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    );
  const source = () => readFile(path, "utf8");
  await page.goto(`/#project/${project.id}`);
  await expect(
    page.locator(overlap ? '[data-clip="intro"]' : '[data-clip="cta"]'),
  ).toBeVisible();
  await expect(page.locator("iframe[data-live]")).toHaveCount(1);
  await expect(page.locator(".tl-grid")).toHaveAttribute(
    "data-refit",
    "settled",
  );
  const seek = async (value: string) => {
    await page.getByRole("button", { name: /^Current time/ }).click();
    await page.getByLabel("Go to time").pressSequentially(value);
    await page.keyboard.press("Enter");
  };
  const shown = async () => {
    const title = page.frameLocator("iframe[data-live]").locator("#cta");
    await expect(title).toBeVisible();
    await expect
      .poll(() =>
        title.evaluate((element) => Number(getComputedStyle(element).opacity)),
      )
      .toBeGreaterThan(0.5);
  };
  return { project, base, read, source, seek, shown, html };
}

test("W ripple warns about the checkpoint title; script and exported animation remain unchanged", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  const { project, read, source, seek, shown, html } = await open(
    page,
    request,
  );
  await seek("3608");
  await shown();
  await page.screenshot({ path: info.outputPath("before.png") });
  await page.locator('[data-clip="shot-b"]').click();
  await seek("1811");
  await page.keyboard.press("w");
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.find((clip) => clip.id === "cta")!.start,
    )
    .toBe(731);
  const moved = await source();
  expect(moved.match(/<script\b[^]*?<\/script>/g)).toEqual(
    html.match(/<script\b[^]*?<\/script>/g),
  );
  await seek("2419");
  await expect(
    page.frameLocator("iframe[data-live]").locator("#cta"),
  ).toHaveCSS("opacity", "0");
  await page.screenshot({ path: info.outputPath("after.png") });
  await expect(
    page.locator(".toast").filter({ hasText: "animation" }),
  ).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect.poll(source).toBe(html);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(source).toBe(moved);
  await expect(
    page.frameLocator("iframe[data-live]").locator("#cta"),
  ).toHaveCSS("opacity", "0");

  const directory = info.outputPath("export");
  await mkdir(directory, { recursive: true });
  const response = await request.post(`/api/projects/${project.id}/export`, {
    data: {
      range: { start: 731, end: 761 },
      quality: "draft",
      directory,
      filename: "checkpoint.mp4",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { jobId } = z
    .object({ jobId: z.string() })
    .parse(await response.json());
  const jobSchema = z.object({
    status: z.string(),
    outputPath: z.string().optional(),
    error: z.string().nullable().optional(),
  });
  let outputPath: string | undefined;
  await expect
    .poll(
      async () => {
        const job = jobSchema.parse(
          await (await request.get(`/api/render/${jobId}`)).json(),
        );
        if (job.status === "failed")
          throw new Error(job.error ?? "Export failed");
        outputPath = job.outputPath;
        return job.status;
      },
      { timeout: 90_000 },
    )
    .toBe("complete");
  const exported = info.outputPath("exported-frame.png");
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-ss",
    "0.266667",
    "-i",
    outputPath!,
    "-frames:v",
    "1",
    exported,
  ]);
  // Scripts stay authored: the warning does not repair the missing title in exported pixels.
  const { stdout } = await promisify(execFile)(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      exported,
      "-vf",
      "crop=1100:130:410:420,format=rgb24",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 2_000_000 },
  );
  let white = 0;
  for (let i = 0; i < stdout.length; i += 3)
    if (stdout[i] > 170 && stdout[i + 1] > 170 && stdout[i + 2] > 170) white++;
  expect(white).toBe(0);
  await info.attach("exported frame", {
    path: exported,
    contentType: "image/png",
  });
});

test("timeline move, Inspector Start and real MCP moves all warn without changing scripts", async ({
  page,
  request,
  baseURL,
}) => {
  const { project, read, source, seek, shown, html } = await open(
    page,
    request,
  );
  const cta = page.locator('[data-clip="cta"]');
  await cta.click();
  // A real drag one second earlier, with snapping disabled for a literal mouse move.
  await page.getByRole("button", { name: /^Snapping/ }).click();
  const box = (await cta.boundingBox())!;
  const width =
    (await page.locator('[data-clip="shot-c"]').boundingBox())!.width / 18;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - width, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.find((clip) => clip.id === "cta")!.start,
    )
    .not.toBe(1080);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector
    .getByRole("textbox", { name: "Start", exact: true })
    .fill("38s");
  await inspector
    .getByRole("textbox", { name: "Start", exact: true })
    .press("Enter");
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.find((c) => c.id === "cta")!.start,
    )
    .toBe(1140);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Call to action's animation stayed behind." }),
  ).toBeVisible();
  expect((await source()).match(/<script\b[^]*?<\/script>/g)).toEqual(
    html.match(/<script\b[^]*?<\/script>/g),
  );
  const client = new Client({ name: "tween-browser-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const before = await read();
    const result = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: before.revision,
        commands: [{ type: "move", clipIds: ["cta"], by: -60, mode: "place" }],
      },
    });
    expect(result.isError).not.toBe(true);
    await expect
      .poll(
        async () =>
          (await read()).timeline.clips.find((c) => c.id === "cta")!.start,
      )
      .toBe(1080);
    expect((await source()).match(/<script\b[^]*?<\/script>/g)).toEqual(
      html.match(/<script\b[^]*?<\/script>/g),
    );
    await seek("3608");
    await shown();
  } finally {
    await client.close();
  }
});

test("animation shows one dismissible Ask agent toast, saving a Review note only on request", async ({
  page,
  request,
  baseURL,
}) => {
  const { project, base, read, seek, html, source } = await open(
    page,
    request,
    true,
  );
  await page.locator('[data-clip="shot-b"]').click();
  await seek("1811");
  await page.keyboard.press("w");
  const toast = page
    .getByRole("status")
    .filter({ hasText: "Call to action's animation stayed behind." });
  await expect(toast).toBeVisible();
  await expect(
    toast.getByRole("button", { name: "Dismiss", exact: true }),
  ).toBeVisible();
  expect((await source()).slice((await source()).indexOf("const tl"))).toBe(
    html.slice(html.indexOf("const tl")),
  );
  expect(
    (await (await request.get(`${base}/review`)).json()).items,
  ).toHaveLength(0);
  await toast.getByRole("button", { name: "Ask agent", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${base}/review`)).json()).items.length,
    )
    .toBe(1);
  const note = (await (await request.get(`${base}/review`)).json()).items[0];
  expect(note.body).toContain(
    "Move the title into its own sub-composition file",
  );
  expect(note.elementId).toBe("cta");
  expect(note.time).toBe(24.366667);
  await expect(
    page.locator(".toast").filter({ hasText: "animation" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-clip="cta"]')).toBeVisible();
  await expect(
    page.locator(".toast").filter({ hasText: "animation" }),
  ).toHaveCount(0);
  // An MCP edit warns its caller and leaves observer editors quiet.
  const client = new Client({ name: "animation-warning-test", version: "1" });
  const warning = Promise.withResolvers<unknown>();
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) =>
    warning.resolve(n.params.data),
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: (await read()).revision,
        commands: [{ type: "move", clipIds: ["cta"], by: 30, mode: "place" }],
      },
    });
    await warning.promise;
    await expect(toast).toHaveCount(0);
    expect(
      (await (await request.get(`${base}/review`)).json()).items,
    ).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("several animated clips share one toast and Ask agent adds a note to each", async ({
  page,
  request,
}) => {
  const { base, seek } = await open(page, request, true, 3);
  await page.locator('[data-clip="shot-b"]').click();
  await seek("1811");
  await page.keyboard.press("w");
  const toast = page
    .getByRole("status")
    .filter({ hasText: "3 clips left their animation behind." });
  await expect(toast).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(1);
  await toast.getByRole("button", { name: "Ask agent", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${base}/review`)).json()).items.length,
    )
    .toBe(3);
  const notes = (await (await request.get(`${base}/review`)).json()).items;
  expect(
    notes.map((note: { elementId: string }) => note.elementId).sort(),
  ).toEqual(["cta", "extra-0", "extra-1"]);
});

test("W overlap warns once for the shortened lower third and later title; Ask agent saves both notes", async ({
  page,
  request,
}, info) => {
  const { base, read, source, seek, html } = await open(
    page,
    request,
    false,
    1,
    true,
  );
  await seek("0615");
  await expect(
    page.frameLocator("iframe[data-live]").locator("#title"),
  ).toHaveCSS("opacity", "1");
  await page.screenshot({ path: info.outputPath("before.png") });
  await page.locator('[data-clip="intro"]').click();
  await seek("0100");
  await page.keyboard.press("w");
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.find((c) => c.id === "title")!.start,
    )
    .toBe(30);
  await seek("0115");
  const toast = page
    .getByRole("status")
    .filter({ hasText: "2 clips left their animation behind." });
  await expect(toast).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(1);
  await expect(
    page.frameLocator("iframe[data-live]").locator("#title"),
  ).toHaveCSS("opacity", "0");
  const written = await source();
  expect(written.match(/<script\b[^]*?<\/script>/g)).toEqual(
    html.match(/<script\b[^]*?<\/script>/g),
  );
  await page.screenshot({ path: info.outputPath("after.png") });
  await page.keyboard.press("Control+z");
  await expect.poll(source).toBe(html);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(source).toBe(written);
  await toast.getByRole("button", { name: "Ask agent", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${base}/review`)).json()).items.length,
    )
    .toBe(2);
  const notes = (await (await request.get(`${base}/review`)).json()).items;
  expect(notes.map((n: { elementId: string }) => n.elementId).sort()).toEqual([
    "other",
    "title",
  ]);
  expect(
    notes.every((n: { body: string }) =>
      n.body.includes("Move the title into its own sub-composition file"),
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.locator('[data-clip="title"]')).toBeVisible();
  await expect(
    page.locator(".toast").filter({ hasText: "animation" }),
  ).toHaveCount(0);
});
