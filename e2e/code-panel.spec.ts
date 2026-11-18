import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

/** Three cards far enough apart that showing the last one scrolls the source. */
const cards = Array.from(
  { length: 3 },
  (_, index) =>
    `<div id="card-${index + 1}" class="clip" style="position:absolute;inset:0;color:#fff;font-size:64px" data-start="${index * 2}" data-duration="2" data-track-index="0">Card ${["one", "two", "three"][index]}</div>${"\n<!-- spacer -->".repeat(40)}`,
).join("\n");

async function cardsProject(request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Code panel", duration: 6 },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      /(<main[^>]*>)[\s\S]*<\/main>/,
      `$1\n${cards}\n</main>`,
    ),
  );
  return { project, index };
}

async function openCode(page: Page) {
  await expect(page.locator("[data-clip]")).toHaveCount(3);
  await page.keyboard.press("Control+Alt+C");
  const code = page.getByRole("region", { name: "Code" });
  await expect(code.locator(".cm-content")).toContainText("<!doctype html>");
  return code;
}

/** Selects the first match of `text` with the editor's own search, as a person would. */
async function find(
  page: Page,
  code: ReturnType<Page["locator"]>,
  text: string,
) {
  await code.locator(".cm-content").click();
  await page.keyboard.press("Control+f");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
}

test("the code panel saves an edit as one undo step, and the preview and buffer follow it", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project, index } = await cardsProject(request);
  const original = await readFile(index, "utf8");
  await page.goto(`/#project/${project.id}`);
  const code = await openCode(page);
  await expect(
    code.getByRole("button", { name: "index.html" }),
  ).toHaveAttribute("aria-current", "true");
  // Fonts and other files that are not source are listed but never opened as text.
  await code.getByText("assets", { exact: true }).click();
  await code.getByText("fonts", { exact: true }).click();
  await expect(
    code.getByText("Oswald-var.woff2", { exact: true }),
  ).toBeVisible();
  await expect(
    code.getByRole("button", { name: "Oswald-var.woff2" }),
  ).toHaveCount(0);

  await find(page, code, "Card one");
  await page.keyboard.type("Card edited");
  await expect(code.getByText("Edited", { exact: true })).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect(code.getByText("Edited", { exact: true })).toHaveCount(0);
  expect(await readFile(index, "utf8")).toBe(
    original.replace("Card one", "Card edited"),
  );
  await expect(
    page.frameLocator("iframe[data-live]").locator("#card-1"),
  ).toHaveText("Card edited");

  // The project's undo takes the save back, and the clean buffer follows the file.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => readFile(index, "utf8")).toBe(original);
  await expect(code.locator(".cm-activeLine")).toContainText("Card one");
  await expect(code.getByText("Edited", { exact: true })).toHaveCount(0);
  await expect(
    page.frameLocator("iframe[data-live]").locator("#card-1"),
  ).toHaveText("Card one");

  // The key closes the panel from inside the editor and keeps it closed on reload.
  await code.locator(".cm-content").click();
  await page.keyboard.press("Control+Alt+C");
  await expect(code).toBeHidden();
  await page.reload();
  await expect(page.locator("[data-clip]")).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Code" })).toBeHidden();
  expect(errors).toEqual([]);
});

test("selecting a clip shows its element in the source without taking the keyboard", async ({
  page,
  request,
}) => {
  const { project } = await cardsProject(request);
  await page.goto(`/#project/${project.id}`);
  const code = await openCode(page);
  await page.locator('[data-clip="card-3"]').click();
  await expect(code.locator(".cm-activeLine")).toContainText('id="card-3"');
  await expect(code.locator(".cm-activeLine")).toBeInViewport();
  await page.locator('[data-clip="card-1"]').click();
  await expect(code.locator(".cm-activeLine")).toContainText('id="card-1"');
  expect(
    await page.evaluate(() => !!document.activeElement?.closest(".cm-editor")),
  ).toBe(false);
});

test("an agent's write refreshes a clean buffer and is a conflict over an edited one, never overwritten", async ({
  page,
  request,
  baseURL,
}) => {
  const { project, index } = await cardsProject(request);
  await page.goto(`/#project/${project.id}`);
  const code = await openCode(page);

  const agent = new Client({ name: "code-panel-agent", version: "1.0.0" });
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  const write = async (from: string, to: string) => {
    const source = z
      .object({ structuredContent: z.object({ result: SourceSchema }) })
      .parse(
        await agent.callTool({
          name: "source_read",
          arguments: { projectId: project.id, path: "index.html" },
        }),
      ).structuredContent.result;
    const written = await agent.callTool({
      name: "source_write",
      arguments: {
        projectId: project.id,
        path: "index.html",
        content: source.content.replace(from, to),
        expectedVersion: source.version,
      },
    });
    expect(written.isError).toBeFalsy();
  };
  try {
    // Lines far from the view are not drawn: the clip's jump brings its line on screen.
    await page.locator('[data-clip="card-1"]').click();
    await expect(code.locator(".cm-activeLine")).toContainText("Card one");
    await write("Card one", "Card by agent");
    await expect(code.locator(".cm-activeLine")).toContainText("Card by agent");
    await expect(code.getByRole("alert")).toHaveCount(0);

    await find(page, code, "Card three");
    await page.keyboard.type("Card by person");
    await write("Card two", "Card two by agent");
    const alert = code.getByRole("alert");
    await expect(alert).toContainText("Changed outside the code panel.");
    // Saving is refused while the conflict stands: the agent's text stays on disk.
    await page.keyboard.press("Control+s");
    await expect(alert).toBeVisible();
    const agents = await readFile(index, "utf8");
    expect(agents).toContain("Card two by agent");
    expect(agents).not.toContain("Card by person");

    await alert.getByRole("button", { name: "Save mine" }).click();
    await expect(alert).toHaveCount(0);
    await expect
      .poll(() => readFile(index, "utf8"))
      .toBe(
        agents
          .replace("Card three", "Card by person")
          .replace("Card two by agent", "Card two"),
      );
  } finally {
    await agent.close();
  }
});

test("a missing composition root offers the source and undo from the timeline", async ({
  page,
  request,
}) => {
  const { project } = await cardsProject(request);
  const path = `/api/cutroom/projects/${project.id}/source`;
  const original = SourceSchema.parse(await (await request.get(path)).json());
  const broken = original.content.replace(/ data-composition-id="[^"]+"/, "");
  expect(broken).not.toBe(original.content);
  const saved = await request.put(path, {
    data: {
      path: "index.html",
      expectedVersion: original.version,
      content: broken,
    },
  });
  expect(saved.ok()).toBe(true);

  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.getByRole("alert")).toHaveText(
    "index.html has no composition to edit. Add data-composition-id to its root element, or undo the last change.",
  );
  await timeline.getByRole("button", { name: "Open source" }).click();
  const code = page.getByRole("region", { name: "Code" });
  await expect(
    code.getByRole("button", { name: "index.html" }),
  ).toHaveAttribute("aria-current", "true");
  await timeline.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(timeline.locator("[data-clip]")).toHaveCount(3);
});
