import { expect, test } from "./fixtures";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { embeddedEditor } from "./embedded";

test.beforeEach(({ page }) => embeddedEditor(page));

test("source editing saves, updates the preview, and supports native editor undo", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: false,
        skills: [],
        models: [],
        mcpServers: [],
      },
    }),
  );
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Source editing" },
      })
    ).json(),
  );
  const original = SourceSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/source`)
    ).json(),
  );
  await page.goto(`/#project/${project.id}?v=1&rc=1&tv=1`);
  const frame = page.frameLocator("hyperframes-player iframe").last();
  await expect(frame.locator("#headline")).toHaveText("Source editing");
  await page
    .getByRole("button", { name: "Toggle project files", exact: true })
    .click();
  await page.getByRole("tab", { name: "Code", exact: true }).click();
  await page
    .getByText("index.html", { exact: true })
    .filter({ visible: true })
    .click();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("Source editing");
  const changed = original.content.replaceAll(
    "Source editing",
    "A clear change",
  );
  await editor.fill(changed);
  await expect
    .poll(
      async () =>
        SourceSchema.parse(
          await (
            await request.get(`/api/cutroom/projects/${project.id}/source`)
          ).json(),
        ).content,
    )
    .toBe(changed);
  await expect(frame.locator("#headline")).toHaveText("A clear change");
  await editor.press("Control+z");
  await expect
    .poll(
      async () =>
        SourceSchema.parse(
          await (
            await request.get(`/api/cutroom/projects/${project.id}/source`)
          ).json(),
        ).content,
    )
    .toBe(original.content);
  await expect(frame.locator("#headline")).toHaveText("Source editing");
  await editor.focus();
  const latest = SourceSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/source`)
    ).json(),
  );
  const outside = latest.content.replaceAll(
    "Source editing",
    "An outside edit",
  );
  const saved = await request.put(
    `/api/cutroom/projects/${project.id}/source`,
    {
      data: {
        path: "index.html",
        expectedVersion: latest.version,
        content: outside,
      },
    },
  );
  expect(saved.ok()).toBeTruthy();
  await expect(frame.locator("#headline")).toHaveText("An outside edit");
  await page.getByRole("button", { name: "Select (V)", exact: true }).click();
  await expect(editor).toContainText("An outside edit");
  await editor.press("Control+End");
  await editor.press("Enter");
  await page.keyboard.insertText("<!-- local follow-up -->");
  await expect
    .poll(
      async () =>
        SourceSchema.parse(
          await (
            await request.get(`/api/cutroom/projects/${project.id}/source`)
          ).json(),
        ).content,
    )
    .toContain("<!-- local follow-up -->");
  expect(
    SourceSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/source`)
      ).json(),
    ).content,
  ).toContain("An outside edit");
  expect(errors).toEqual([]);
});

test("autosave preserves an outside edit that lands before its queued file read", async ({
  page,
  request,
}) => {
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: false,
        skills: [],
        models: [],
        mcpServers: [],
      },
    }),
  );
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Source race" },
      })
    ).json(),
  );
  const original = SourceSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/source`)
    ).json(),
  );
  await page.goto(`/#project/${project.id}?v=1&rc=1&tv=1`);
  await expect(
    page.frameLocator("hyperframes-player iframe").last().locator("#headline"),
  ).toHaveText("Source race");
  await page
    .getByRole("button", { name: "Toggle project files", exact: true })
    .click();
  await page.getByRole("tab", { name: "Code", exact: true }).click();
  await page
    .getByText("index.html", { exact: true })
    .filter({ visible: true })
    .click();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await expect(editor).toContainText("Source race");

  let reachedRead = () => {};
  let releaseRead = () => {};
  const readPaused = new Promise<void>((resolve) => {
    reachedRead = resolve;
  });
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let paused = false;
  await page.route(
    `**/api/projects/${project.id}/files/index.html`,
    async (route) => {
      if (!paused && route.request().method() === "GET") {
        paused = true;
        reachedRead();
        await readReleased;
      }
      await route.continue();
    },
  );
  const local = original.content.replaceAll("Source race", "Local draft");
  const outside = original.content.replace(
    "A new composition.",
    "Outside caption",
  );
  try {
    await editor.fill(
      original.content.replaceAll("Source race", "First local draft"),
    );
    await readPaused;
    await editor.fill(local);
    const saved = await request.put(
      `/api/cutroom/projects/${project.id}/source`,
      {
        data: {
          path: "index.html",
          expectedVersion: original.version,
          content: outside,
        },
      },
    );
    expect(saved.ok()).toBeTruthy();
    releaseRead();
    const conflict = page.getByRole("button", {
      name: "Review or export both",
      exact: true,
    });
    await expect
      .poll(async () => {
        const disk = SourceSchema.parse(
          await (
            await request.get(`/api/cutroom/projects/${project.id}/source`)
          ).json(),
        );
        return disk.content === local || (await conflict.isVisible());
      })
      .toBe(true);
    expect(
      SourceSchema.parse(
        await (
          await request.get(`/api/cutroom/projects/${project.id}/source`)
        ).json(),
      ).content,
    ).toBe(outside);
    await expect(conflict).toBeVisible();
    await expect(editor).toContainText("Local draft");
    await conflict.click();
    await expect(
      page.getByRole("region", { name: "File on disk" }).locator("textarea"),
    ).toHaveValue(outside);
    await expect(
      page
        .getByRole("region", { name: "Unsaved Studio version" })
        .locator("textarea"),
    ).toHaveValue(local);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Discard Studio edits and reload file",
        exact: true,
      })
      .click();
    await expect(editor).toContainText("Outside caption");
    await expect(editor).not.toContainText("Local draft");
  } finally {
    releaseRead();
  }
});

test("successive local edits remain saveable while an earlier source save is queued", async ({
  page,
  request,
}) => {
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: false,
        skills: [],
        models: [],
        mcpServers: [],
      },
    }),
  );
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Queued source" },
      })
    ).json(),
  );
  const original = SourceSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/source`)
    ).json(),
  );
  await page.goto(`/#project/${project.id}?v=1&rc=1&tv=1`);
  await expect(
    page.frameLocator("hyperframes-player iframe").last().locator("#headline"),
  ).toHaveText("Queued source");
  await page
    .getByRole("button", { name: "Toggle project files", exact: true })
    .click();
  await page.getByRole("tab", { name: "Code", exact: true }).click();
  await page
    .getByText("index.html", { exact: true })
    .filter({ visible: true })
    .click();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await expect(editor).toContainText("Queued source");
  let reachedRead = () => {};
  let releaseRead = () => {};
  const readPaused = new Promise<void>((resolve) => {
    reachedRead = resolve;
  });
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let paused = false;
  await page.route(
    `**/api/projects/${project.id}/files/index.html`,
    async (route) => {
      if (!paused && route.request().method() === "GET") {
        paused = true;
        reachedRead();
        await readReleased;
      }
      await route.continue();
    },
  );
  const first = original.content.replaceAll(
    "Queued source",
    "First local edit",
  );
  const latest = first.replace("A new composition.", "A newer local caption");
  try {
    await editor.fill(first);
    await readPaused;
    await editor.fill(latest);
    releaseRead();
    await expect
      .poll(
        async () =>
          SourceSchema.parse(
            await (
              await request.get(`/api/cutroom/projects/${project.id}/source`)
            ).json(),
          ).content,
      )
      .toBe(latest);
    await expect(
      page.getByRole("button", { name: "Review or export both", exact: true }),
    ).toHaveCount(0);
    await expect(editor).toContainText("A newer local caption");
    await expect(
      page.frameLocator("hyperframes-player iframe").last().locator("#caption"),
    ).toHaveText("A newer local caption");
  } finally {
    releaseRead();
  }
});
