import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { browserExecutable } from "../src/server/hyperframes/render";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createReviewService } from "../src/server/projects/review";
import { createProjectStore } from "../src/server/projects/store";
import { createTimelineRoutes } from "../src/server/timeline/routes";

async function assetFixture() {
  const root = await mkdtemp(join(tmpdir(), "cutroom-preview-assets-"));
  const store = await createProjectStore({ dataDir: root });
  const project = await store.create({
    name: "Asset reader",
    width: 320,
    height: 240,
    duration: 1,
  });
  const other = await store.create({ name: "Private project" });
  await writeFile(join(other.path, "private.txt"), "OTHER_PROJECT_SECRET");
  await writeFile(join(project.path, "local-data"), '{"asset":"LOCAL_ASSET"}');
  await symlink(
    join(other.path, "private.txt"),
    join(project.path, "linked.txt"),
  );
  await symlink(other.path, join(project.path, "linked-dir"));
  await symlink(
    join(project.path, "local-data"),
    join(project.path, "inside.json"),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>body{margin:0}</style></head><body><main data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-duration="1"><div id="swatch" class="clip" data-start="0" data-duration="1" data-track-index="0" style="position:absolute;inset:0;background:blue"></div></main><script>
    Promise.all(["linked.txt", "linked-dir/private.txt", "inside.json"].map(async path => {
      const response = await fetch(path);
      return {path, status:response.status, body:await response.text(), type:response.headers.get("content-type")};
    })).then(results => {
      window.assetResults = results;
      const denied = results[0].status === 403 && results[1].status === 403;
      const local = results[2].status === 200 && results[2].body === '{"asset":"LOCAL_ASSET"}' && results[2].type.startsWith("application/json");
      const swatch = document.getElementById("swatch");
      swatch.style.background = denied && local ? "rgb(0,255,0)" : "rgb(255,0,0)";
      swatch.textContent = results.filter(result => result.status === 200).map(result => result.body).join(" ");
    });
  </script></body></html>`,
  );
  const review = createReviewService(store);
  const api = createHyperframesApi(store, review);
  const app = new Hono()
    .route("/api", api)
    .route("/api/cutroom", createTimelineRoutes(store, review));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    fetch: app.fetch,
  });
  const baseUrl = server.url.origin;
  const mcp = createMcpHttpHandler({ baseUrl });
  app.all("/mcp", (c) => mcp(c.req.raw));
  const request = (path: string, body?: unknown) =>
    fetch(
      `${baseUrl}${path}`,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { origin: baseUrl, "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
  return {
    root,
    project,
    request,
    baseUrl,
    async dispose() {
      await api.dispose();
      await store.close();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function greenFrame(path: string) {
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      "crop=2:2:160:120,format=rgb24",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const bytes = new Uint8Array(
    await new Response(process.stdout).arrayBuffer(),
  );
  const error = await new Response(process.stderr).text();
  if ((await process.exited) !== 0) throw new Error(error);
  expect(bytes[0]).toBeLessThan(20);
  expect(bytes[1]).toBeGreaterThan(230);
  expect(bytes[2]).toBeLessThan(20);
}

test.skipIf(!browserExecutable())(
  "preview fetch rejects file and directory symlinks into another project while allowing internal links",
  async () => {
    const fixture = await assetFixture();
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: browserExecutable(),
      args: ["--no-sandbox", "--mute-audio"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(
        `${fixture.baseUrl}/api/projects/${fixture.project.id}/isolated-preview`,
      );
      await page.waitForFunction("Array.isArray(window.assetResults)");
      const results = await page.evaluate("window.assetResults");
      expect(results).toEqual([
        {
          path: "linked.txt",
          status: 403,
          body: expect.not.stringContaining("OTHER_PROJECT_SECRET"),
          type: expect.stringContaining("text/plain"),
        },
        {
          path: "linked-dir/private.txt",
          status: 403,
          body: expect.not.stringContaining("OTHER_PROJECT_SECRET"),
          type: expect.stringContaining("text/plain"),
        },
        {
          path: "inside.json",
          status: 200,
          body: '{"asset":"LOCAL_ASSET"}',
          type: expect.stringContaining("application/json"),
        },
      ]);
      const encoded = await page.evaluate(async () =>
        Promise.all(
          [
            "linked%2Etxt?cache=1",
            "linked-dir%2Fprivate.txt",
            "comp/linked.txt",
            "inside%2Ejson",
          ].map(async (path) => (await fetch(path)).status),
        ),
      );
      expect(encoded).toEqual([403, 403, 403, 200]);
      expect(
        await page.$eval(
          "#swatch",
          (element) => getComputedStyle(element).backgroundColor,
        ),
      ).toBe("rgb(0, 255, 0)");
    } finally {
      await browser.close();
      await fixture.dispose();
    }
  },
  // Launching a real browser can outlast Bun's 5 s default on a loaded CI runner.
  30_000,
);

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "timeline_view cannot paint another project's symlinked secret into its frame",
  async () => {
    const fixture = await assetFixture();
    const client = new Client({ name: "asset-isolation-test", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${fixture.baseUrl}/mcp`)),
      );
      const result = await client.callTool({
        name: "timeline_view",
        arguments: { projectId: fixture.project.id, frame: 0 },
      });
      expect(result.isError).not.toBe(true);
      const content = z
        .object({ content: z.array(z.looseObject({ type: z.string() })) })
        .parse(result).content;
      const image = z
        .object({ data: z.string() })
        .parse(content.find((block) => block.type === "image"));
      const path = join(fixture.root, "timeline.jpg");
      await writeFile(path, Buffer.from(image.data, "base64"));
      await greenFrame(path);
    } finally {
      await client.close();
      await fixture.dispose();
    }
  },
  30_000,
);

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "export denies cross-project symlink reads and still renders an internal linked asset",
  async () => {
    const fixture = await assetFixture();
    try {
      // Images, unlike fetched data, are inputs the renderer waits for before it captures.
      const dir = fixture.project.path;
      const png = (color: string, path: string) =>
        Bun.spawn([
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=c=${color}:s=320x240`,
          "-frames:v",
          "1",
          path,
        ]).exited;
      await png("0x00ff00", join(dir, "green.png"));
      await png("0xff0000", join(dir, "linked-dir", "red.png"));
      await symlink(join(dir, "green.png"), join(dir, "inside.png"));
      await symlink(
        join(dir, "linked-dir", "red.png"),
        join(dir, "linked.png"),
      );
      // A readable cross-project image would paint red over the internal green one.
      const layer = "position:absolute;inset:0;width:100%;height:100%";
      await writeFile(
        join(dir, "index.html"),
        `<!doctype html><html><head><style>body{margin:0}</style></head><body><main data-composition-id="main" data-no-timeline data-width="320" data-height="240" data-duration="1" style="position:relative;width:320px;height:240px;background:blue"><img src="inside.png" alt="" style="${layer}"><img src="linked.png" alt="" style="${layer}" onerror="this.remove()"><img src="linked-dir/red.png" alt="" style="${layer}" onerror="this.remove()"></main></body></html>`,
      );
      const started = await fixture.request(
        `/api/projects/${fixture.project.id}/render`,
        { fps: 2, quality: "draft", format: "mp4", telemetryOptOut: true },
      );
      const { jobId } = z
        .object({ jobId: z.string() })
        .parse(await started.json());
      const progress = await (
        await fixture.request(`/api/render/${jobId}/progress`)
      ).text();
      expect(progress).toContain('"status":"complete"');
      const video = await fixture.request(`/api/render/${jobId}/download`);
      expect(video.status).toBe(200);
      const path = join(fixture.root, "export.mp4");
      await writeFile(path, new Uint8Array(await video.arrayBuffer()));
      await greenFrame(path);
    } finally {
      await fixture.dispose();
    }
  },
  90_000,
);
