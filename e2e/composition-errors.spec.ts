import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

const result = <T>(schema: z.ZodType<T>, value: unknown) => {
  expect(
    z.object({ isError: z.boolean().optional() }).parse(value).isError,
  ).not.toBe(true);
  return z
    .object({ structuredContent: z.object({ result: schema }) })
    .parse(value).structuredContent.result;
};

for (const kind of [
  "root",
  "nested",
  "missing",
  "startup",
  "uncaught",
  "syntax",
  "nested-startup",
] as const)
  test(`${kind} composition failures reach the header and an outside MCP client`, async ({
    page,
    baseURL,
  }, testInfo) => {
    const client = new Client({
      name: "composition-error-proof",
      version: "1",
    });
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
            name: `Broken ${kind} title`,
            duration: 2,
            width: 320,
            height: 240,
          },
        }),
      );
      await mkdir(join(project.path, "compositions"));
      await writeFile(
        join(project.path, "compositions/broken.html"),
        `<template><div id="root" data-composition-id="broken" data-width="320" data-height="240">Static title</div><script>${kind === "syntax" ? "const = ;" : kind === "nested-startup" ? 'window.__hf ??= {}; window.__hf.buildReady = { broken: Promise.reject(new Error("Scene setup rejected")) };' : 'throw new Error("Title setup exploded")'}</script></template>`,
      );
      const original = result(
        SourceSchema,
        await client.callTool({
          name: "source_read",
          arguments: { projectId: project.id },
        }),
      );
      const write = async (content: string) => {
        const source = result(
          SourceSchema,
          await client.callTool({
            name: "source_read",
            arguments: { projectId: project.id },
          }),
        );
        return result(
          SourceSchema,
          await client.callTool({
            name: "source_write",
            arguments: {
              projectId: project.id,
              expectedVersion: source.version,
              content,
            },
          }),
        );
      };
      const setup =
        kind === "root"
          ? '<script>throw new Error("Title setup exploded")</script>'
          : kind === "uncaught"
            ? '<script>setInterval(() => { throw new Error("Title setup exploded") }, 16)</script>'
            : kind === "startup"
              ? '<script>window.__hf ??= {}; window.__hf.buildReady = { main: Promise.reject(new Error("Scene setup rejected")) };</script>'
              : `<div id="broken" class="clip" data-composition-id="broken" data-composition-src="compositions/${kind === "missing" ? "absent" : "broken"}.html" data-start="0" data-duration="2" data-track-index="3" data-width="320" data-height="240"></div>`;
      await write(original.content.replace("</main>", `${setup}</main>`));
      await page.goto(`/#project/${project.id}`);
      await expect(
        page.getByRole("button", { name: project.name, exact: true }),
      ).toBeVisible();
      const view = CallToolResultSchema.parse(
        await client.callTool({
          name: "timeline_view",
          arguments: { projectId: project.id, frame: 15 },
        }),
      );
      await testInfo.attach("MCP response", {
        body: JSON.stringify({
          isError: view.isError,
          content: view.content.filter((item) => item.type === "text"),
        }),
        contentType: "application/json",
      });
      await page.screenshot({ path: testInfo.outputPath("broken.png") });
      expect(view.isError).toBe(true);
      const file = ["nested", "syntax", "nested-startup"].includes(kind)
        ? "compositions/broken.html"
        : kind === "missing"
          ? "compositions/absent.html"
          : "index.html";
      const message =
        kind === "missing"
          ? "could not be loaded"
          : kind.endsWith("startup")
            ? "Scene setup rejected"
            : kind === "syntax"
              ? "SyntaxError"
              : "Title setup exploded";
      expect(JSON.stringify(view.content)).toContain(file);
      expect(JSON.stringify(view.content)).toContain(message);
      const notice = page.locator("header [role=alert]");
      await expect(notice).toContainText(file);
      await expect(notice).toContainText(message);
      await page.screenshot({ path: testInfo.outputPath("notice.png") });
      await notice.getByRole("button", { name: "Dismiss" }).click();
      if (!kind.endsWith("startup")) {
        await page
          .getByRole("button", { name: "Play forward", exact: true })
          .click();
        await expect(
          page.getByRole("button", {
            name: "Current time. Click to type a time.",
          }),
        ).not.toHaveText("00:00:00:00");
        await page.getByRole("button", { name: "Stop", exact: true }).click();
      }
      await expect(notice).toHaveCount(0);
      await write(original.content);
      await expect(page.locator("iframe[data-live]")).toHaveCount(1);
      await expect
        .poll(async () =>
          Boolean(
            (
              await client.callTool({
                name: "timeline_view",
                arguments: { projectId: project.id, frame: 15 },
              })
            ).isError,
          ),
        )
        .toBe(false);
      await expect(notice).toHaveCount(0);
    } finally {
      await client.close();
    }
  });
