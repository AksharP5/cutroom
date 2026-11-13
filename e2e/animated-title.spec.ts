import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { ExportJobSchema } from "../src/shared/export";
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

test("an outside MCP client follows the animated-title recipe on a fresh offline project", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const client = new Client({ name: "documented-title-recipe", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: new URL(baseURL!).origin } },
    }),
  );
  try {
    const project = result(
      ProjectSchema,
      await client.callTool({
        name: "project_create",
        arguments: { name: "Animated title recipe", duration: 12 },
      }),
    );
    const docs = await readFile(
      new URL("../docs/mcp.md", import.meta.url),
      "utf8",
    );
    const recipe = docs
      .split("### Animated titles")[1]!
      .split("```html")
      .slice(1, 3)
      .map((block) => block.split("```")[0]!.trim());
    expect(recipe).toHaveLength(2);
    result(
      SourceSchema,
      await client.callTool({
        name: "source_write",
        arguments: {
          projectId: project.id,
          path: "compositions/lower.html",
          expectedVersion: null,
          content: recipe[1],
        },
      }),
    );
    const source = result(
      SourceSchema,
      await client.callTool({
        name: "source_read",
        arguments: { projectId: project.id },
      }),
    );
    expect(source.content).toContain(
      '<script src="assets/vendor/gsap.min.js"></script>',
    );
    result(
      SourceSchema,
      await client.callTool({
        name: "source_write",
        arguments: {
          projectId: project.id,
          expectedVersion: source.version,
          content: source.content.replace("</main>", `${recipe[0]}</main>`),
        },
      }),
    );
    await page.route("**/*", async (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue()
        : route.abort(),
    );
    await page.goto(`/#project/${project.id}`);
    const preview = page.frameLocator("iframe[data-live]");
    await expect(preview.locator("#lower-text")).toHaveCount(1);
    const states = [];
    for (const frame of [180, 185, 195]) {
      const view = await client.callTool({
        name: "timeline_view",
        arguments: { projectId: project.id, frame },
      });
      expect(view.isError, JSON.stringify(view)).not.toBe(true);
      const image = z
        .object({
          content: z.array(
            z.object({ type: z.string(), data: z.string().optional() }),
          ),
        })
        .parse(view)
        .content.find((item) => item.type === "image")!;
      await writeFile(
        testInfo.outputPath(`frame-${frame}.jpg`),
        Buffer.from(image.data!, "base64"),
      );
      await testInfo.attach(`MCP frame ${frame}`, {
        path: testInfo.outputPath(`frame-${frame}.jpg`),
        contentType: "image/jpeg",
      });
      await page
        .getByRole("button", { name: "Current time. Click to type a time." })
        .click();
      await page
        .getByRole("textbox", { name: "Go to time" })
        .pressSequentially(`000006${String(frame - 180).padStart(2, "0")}`);
      await page.getByRole("textbox", { name: "Go to time" }).press("Enter");
      const expectedOpacity = frame === 180 ? 0 : frame === 195 ? 1 : undefined;
      if (expectedOpacity !== undefined)
        await expect(preview.locator("#lower-text")).toHaveCSS(
          "opacity",
          String(expectedOpacity),
        );
      else
        await expect
          .poll(() =>
            preview
              .locator("#lower-text")
              .evaluate((text) => Number(getComputedStyle(text).opacity)),
          )
          .toBeGreaterThan(0);
      states.push(
        await preview.locator("#lower-text").evaluate((text) => ({
          opacity: Number(getComputedStyle(text).opacity),
          transform: getComputedStyle(text).transform,
        })),
      );
    }
    expect(states[0]!.opacity).toBe(0);
    expect(states[1]!.opacity).toBeGreaterThan(0);
    expect(states[1]!.opacity).toBeLessThan(1);
    expect(states[2]!.opacity).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("editor.png") });
    const started = result(
      z.object({ jobId: z.string() }),
      await client.callTool({
        name: "export_start",
        arguments: {
          projectId: project.id,
          range: { start: 180, end: 198 },
          quality: "high",
        },
      }),
    );
    const status = async () =>
      result(
        ExportJobSchema,
        await client.callTool({ name: "export_status", arguments: started }),
      );
    await expect
      .poll(async () => (await status()).status, {
        timeout: 60_000,
        intervals: [250, 500],
      })
      .toBe("complete");
    const done = await status();
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-i",
      done.outputPath,
      "-vf",
      "select=eq(n\\,5)",
      "-frames:v",
      "1",
      testInfo.outputPath("export-mid.png"),
    ]);
    const frames = await promisify(execFile)(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        done.outputPath,
        "-vf",
        "select=eq(n\\,0)+eq(n\\,5)+eq(n\\,15),crop=1200:55:60:600,scale=1:1,format=gray",
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "-",
      ],
      { encoding: "buffer" },
    );
    const luminance = [...frames.stdout];
    expect(luminance).toHaveLength(3);
    expect(luminance[1]!).toBeGreaterThan(luminance[0]!);
    expect(luminance[1]!).toBeLessThan(luminance[2]!);
    await testInfo.attach("Export mid-animation", {
      path: testInfo.outputPath("export-mid.png"),
      contentType: "image/png",
    });
    await testInfo.attach("Preview animation states", {
      body: JSON.stringify(states),
      contentType: "application/json",
    });
  } finally {
    await client.close();
  }
});
