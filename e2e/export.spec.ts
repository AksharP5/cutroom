import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "./fixtures";
import { z } from "zod";
import { ProjectSchema, SourceSchema } from "../src/shared/project";

test("exports a local composition through the editor and downloads a playable MP4", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: true,
        skills: [],
        models: [],
        mcpServers: [],
      },
    }),
  );

  const created = await request.post("/api/cutroom/projects", {
    data: {
      name: "Export proof",
      width: 320,
      height: 240,
      duration: 1,
    },
  });
  expect(created.status()).toBe(201);
  const project = ProjectSchema.parse(await created.json());
  const source = SourceSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/source`)
    ).json(),
  );
  const written = await request.put(
    `/api/cutroom/projects/${project.id}/source`,
    {
      data: {
        path: "index.html",
        expectedVersion: source.version,
        content:
          '<!doctype html><html><head><meta charset="UTF-8"><style>html,body{margin:0;background:#17222b}main{position:relative;width:320px;height:240px}.clip{position:absolute;inset:0;background:#ed9a72}</style></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-duration="1"><div id="picture" class="clip" data-start="0" data-duration="1" data-track-index="0"></div></main></body></html>',
      },
    },
  );
  expect(written.ok()).toBeTruthy();

  await page.goto(`/#project/${project.id}?v=1&rc=1&tv=1`);
  await expect(
    page.frameLocator("hyperframes-player iframe").locator("#picture"),
  ).toBeVisible();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/projects/${project.id}/render`),
  );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const response = await started;
  expect(response.ok(), await response.text()).toBeTruthy();
  await expect(
    page.getByRole("tab", { name: /^Renders(?: \(\d+\))?$/ }),
  ).toBeVisible();

  const downloadButton = page.getByRole("button", {
    name: /^Download .+\.mp4$/,
  });
  await expect(downloadButton).toBeEnabled({ timeout: 45_000 });
  const pendingDownload = page.waitForEvent("download");
  await downloadButton.click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
  const path = testInfo.outputPath("export.mp4");
  await download.saveAs(path);
  const bytes = await readFile(path);
  expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");

  const { stdout } = await promisify(execFile)("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,width,height:format=duration",
    "-of",
    "json",
    path,
  ]);
  const encoded = z
    .object({
      streams: z.array(
        z.object({
          codec_type: z.string(),
          width: z.number().optional(),
          height: z.number().optional(),
        }),
      ),
      format: z.object({ duration: z.string() }),
    })
    .parse(JSON.parse(stdout));
  expect(
    encoded.streams.find((stream) => stream.codec_type === "video"),
  ).toMatchObject({ width: 320, height: 240 });
  expect(Number(encoded.format.duration)).toBeCloseTo(1, 1);
  expect(errors).toEqual([]);
});
