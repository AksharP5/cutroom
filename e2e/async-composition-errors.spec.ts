import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

const result = <T>(schema: z.ZodType<T>, value: unknown) =>
  z.object({ structuredContent: z.object({ result: schema }) }).parse(value)
    .structuredContent.result;

const scenarios = [
  {
    name: "interval",
    script: 'setInterval(() => { throw new Error("Late nested boom"); }, 16);',
  },
  {
    name: "animation frame",
    script:
      'requestAnimationFrame(() => { throw new Error("Late nested boom"); });',
  },
  {
    name: "event handler",
    script:
      'document.getElementById("late").addEventListener("click", () => { throw new Error("Late nested boom"); }); setTimeout(() => document.getElementById("late").click(), 16);',
  },
  {
    name: "promise rejection",
    script:
      'setTimeout(() => { Promise.reject(new Error("Late nested boom")); }, 16);',
  },
  {
    name: "saved rejection stack",
    file: "compositions/broken scene.html",
    script:
      'const failure = new Error("Late nested boom"); setTimeout(() => Promise.reject(failure), 16);',
  },
  {
    name: "module rejection",
    script:
      'setTimeout(() => Promise.reject(new Error("Late nested boom")), 16);',
    module: true,
  },
  {
    name: "unknown rejection",
    script: 'setTimeout(() => Promise.reject("Unattributed rejection"), 16);',
    unknown: true,
  },
];

for (const scenario of scenarios)
  test(`${scenario.name} retains its composition filename in the header and MCP`, async ({
    page,
    baseURL,
  }, info) => {
    const client = new Client({ name: "async-error-proof", version: "1" });
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
          arguments: {
            name: `Async ${scenario.name}`,
            width: 320,
            height: 240,
            duration: 2,
          },
        }),
      );
      await mkdir(join(project.path, "compositions"));
      const path = scenario.file ?? "compositions/broken.html";
      await writeFile(
        join(project.path, path),
        `<template><div data-composition-id="broken" data-width="320" data-height="240"><button id="late">Title</button></div><script${scenario.module ? ' type="module"' : ""}>${scenario.script}</script></template>`,
      );
      const source = result(
        SourceSchema,
        await client.callTool({
          name: "source_read",
          arguments: { projectId: project.id },
        }),
      );
      const host = `<div id="broken" class="clip" data-composition-id="broken" data-composition-src="${path}" data-start="0" data-duration="2" data-track-index="3" data-width="320" data-height="240"></div>`;
      const save = await client.callTool({
        name: "source_write",
        arguments: {
          projectId: project.id,
          expectedVersion: source.version,
          content: source.content.replace("</main>", `${host}</main>`),
        },
      });
      expect(save.isError).not.toBe(true);
      await page.goto(`/#project/${project.id}`);
      const notice = page.locator("header [role=alert]");
      const message = scenario.unknown
        ? "Unattributed rejection"
        : "Late nested boom";
      await expect(notice).toContainText(message);
      const view = CallToolResultSchema.parse(
        await client.callTool({
          name: "timeline_view",
          arguments: { projectId: project.id, frame: 15 },
        }),
      );
      const text = view.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      await info.attach("MCP error", {
        body: JSON.stringify({ isError: view.isError, text }),
        contentType: "application/json",
      });
      await page.screenshot({ path: info.outputPath("notice.png") });
      expect(view.isError).toBe(true);
      const file = scenario.unknown ? "unknown file" : path;
      expect(text).toBe(
        `Cutroom returned 500: Thumbnail generation failed: ${file}: ${scenario.unknown ? "" : "Error: "}${message}`,
      );
      expect(text).toContain(message);
      await expect(notice).toContainText(`${file}:`);
      await notice.getByRole("button", { name: "Dismiss" }).click();
      await page
        .getByRole("button", { name: "Play forward", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Current time. Click to type a time.",
        }),
      ).not.toHaveText("00:00:00:00");
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(notice).toHaveCount(0);
    } finally {
      await client.close();
    }
  });
