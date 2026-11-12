import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

test("Home refreshes its last-edited date after MCP edits a linked composition", async ({
  page,
  request,
  baseURL,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: `Linked composition date ${Date.now()}`,
          width: 640,
          height: 360,
          duration: 8,
        },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><html><body style="margin:0;background:#111;color:#eee;font-family:sans-serif"><main data-composition-id="main" data-width="640" data-height="360" data-duration="8"><div id="card" data-composition-id="card" data-composition-src="card.html" data-start="0" data-duration="8" data-track-index="0" style="position:absolute;inset:0"></div></main></body></html>',
  );
  await writeFile(
    join(project.path, "card.html"),
    '<template><div data-composition-id="card" data-width="640" data-height="360" data-duration="8"><div id="title" class="clip" data-start="0" data-duration="8" style="position:absolute;left:60px;top:150px;font:36px sans-serif;color:#eee">Old child title</div></div></template>',
  );
  const old = new Date(Date.now() - 3 * 86400000);
  for (const file of ["index.html", "cutroom.json", "card.html"])
    await utimes(join(project.path, file), old, old);
  await page.goto("/");
  const tile = page.locator(".home-project").filter({
    has: page.locator(".home-name").getByText(project.name, { exact: true }),
  });
  const date = tile.locator("time");
  await tile.scrollIntoViewIfNeeded();
  await expect(date).toHaveText("3 d ago");
  await page.screenshot({ path: info.outputPath("before-child-edit.png") });
  const client = new Client({ name: "Linked source reviewer", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const result = z.object({
      structuredContent: z.object({ result: SourceSchema }),
    });
    const source = result.parse(
      await client.callTool({
        name: "source_read",
        arguments: { projectId: project.id, path: "card.html" },
      }),
    ).structuredContent.result;
    const saved = await client.callTool({
      name: "source_write",
      arguments: {
        projectId: project.id,
        path: "card.html",
        expectedVersion: source.version,
        content: source.content.replace("Old child title", "Fresh child title"),
      },
    });
    expect(saved.isError).not.toBe(true);
    expect(await readFile(join(project.path, "card.html"), "utf8")).toContain(
      "Fresh child title",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(date).toHaveText("Just now");
    await tile.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("after-child-edit.png") });
    const listed = await client.callTool({
      name: "projects_list",
      arguments: {},
    });
    const listing = z
      .object({
        structuredContent: z.object({
          result: z.object({ projects: z.array(ProjectSchema) }),
        }),
      })
      .parse(listed).structuredContent.result;
    expect(
      Date.parse(
        listing.projects.find((item) => item.id === project.id)!.updatedAt,
      ),
    ).toBeGreaterThan(Date.now() - 60000);
    await tile.click();
    await expect(page.locator("[data-preview-ready]")).toHaveAttribute(
      "data-preview-ready",
    );
    await page
      .locator(".edit-picture")
      .evaluate((el) =>
        Promise.all(el.getAnimations().map((animation) => animation.finished)),
      );
    await page.screenshot({
      path: info.outputPath("edited-child-in-viewer.png"),
    });
  } finally {
    await client.close();
  }
});
