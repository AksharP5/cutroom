import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./fixtures";
import { ProjectSchema, SourceSchema } from "../src/shared/project";

test("the quality listbox opens from the keyboard, navigates, selects and returns focus", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Menu keys", duration: 1 },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  const trigger = dialog.getByRole("combobox", {
    name: "Quality",
    exact: true,
  });
  const list = dialog.getByRole("listbox", {
    name: "Quality options",
    exact: true,
  });
  await trigger.focus();
  for (const key of ["Enter", "Space", "ArrowDown"]) {
    await trigger.press(key);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(
      list.getByRole("option", { name: "Standard", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(dialog).toBeVisible();
  }
  await trigger.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(
    list.getByRole("option", { name: "High", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    list.getByRole("option", { name: "Draft", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveText("High");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press("Home");
  await expect(
    list.getByRole("option", { name: "Draft", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    list.getByRole("option", { name: "High", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("s");
  await expect(
    list.getByRole("option", { name: "Standard", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveText("Standard");
  await trigger.click();
  await list.getByRole("option", { name: "Draft", exact: true }).click();
  await expect(trigger).toHaveText("Draft");
  await expect(trigger).toBeFocused();
  await trigger.press("Space");
  await page.keyboard.press("Tab");
  await expect(list).toBeHidden();
  await expect(dialog.getByLabel("File name", { exact: true })).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  const motion = await list.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      scale: style.getPropertyValue("--modal-scale"),
      durations: style.transitionDuration,
    };
  });
  expect(motion.scale.trim()).toBe("1");
  expect(
    motion.durations
      .split(",")
      .every((duration) => parseFloat(duration) <= 0.1),
  ).toBe(true);
});

test("agent, footage and viewer pickers share mouse and keyboard selection", async ({
  page,
  request,
}) => {
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider:
          new URL(route.request().url()).searchParams.get("provider") ??
          "codex",
        available: true,
        skills: [],
        mcpServers: [],
        models: [
          { id: "model-a", name: "Model A" },
          { id: "model-b", name: "Model B" },
        ],
      },
    }),
  );
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Shared menus", duration: 1 },
      })
    ).json(),
  );
  for (const title of ["First conversation", "Second conversation"]) {
    const response = await request.post("/api/cutroom/agents/sessions", {
      data: { projectId: project.id, provider: "codex", title },
    });
    expect(response.status()).toBe(201);
  }
  await mkdir(join(project.path, "assets"), { recursive: true });
  const media = join(project.path, "assets/voice.wav");
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=16000:cl=mono",
    "-t",
    "1",
    media,
  ]);
  const source = SourceSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/source`)
    ).json(),
  );
  const response = await request.put(
    `/api/cutroom/projects/${project.id}/source`,
    {
      data: {
        path: "index.html",
        expectedVersion: source.version,
        content: source.content.replace(
          "</main>",
          '<audio id="first" aria-label="first" src="assets/voice.wav" data-start="0" data-duration="0.5" data-track-index="3"></audio><audio id="second" aria-label="second" src="assets/voice.wav" data-start="0.5" data-duration="0.5" data-track-index="3"></audio></main>',
        ),
      },
    },
  );
  expect(response.ok()).toBe(true);
  await page.goto(`/#project/${project.id}`);
  const conversation = page.getByLabel("Conversation", { exact: true });
  await conversation.click();
  await page
    .getByRole("option", { name: "Second conversation", exact: true })
    .click();
  await expect(conversation).toBeEnabled();
  await expect(conversation).toBeFocused();
  await conversation.click();
  await page
    .getByRole("option", { name: "First conversation", exact: true })
    .click();
  await expect(conversation).toHaveText("First conversation");
  await conversation.press("Enter");
  await page.keyboard.press("s");
  await page.keyboard.press("Enter");
  await expect(conversation).toHaveText("Second conversation");

  await expect(conversation).toBeFocused();
  const provider = page.getByLabel("Agent provider", { exact: true });
  await expect(provider).toBeEnabled();
  await provider.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(provider).toHaveText("Claude Code");
  await provider.click();
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  await expect(provider).toHaveText("Codex");
  const model = page.getByLabel("Model", { exact: true });
  await model.click();
  await page.getByRole("option", { name: "Model B", exact: true }).click();
  await expect(model).toHaveText("Model B");
  await model.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(model).toHaveText("Model A");
  await expect(model).toBeFocused();

  await page.getByRole("button", { name: "Script", exact: true }).click();
  const footage = page.getByLabel("Footage", { exact: true });
  await footage.click();
  await page.getByRole("option", { name: "second", exact: true }).click();
  await expect(footage).toHaveText("second");
  await footage.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(footage).toHaveText("first");
  await expect(footage).toBeFocused();
  const zoom = page.getByLabel("Viewer zoom", { exact: true });
  await zoom.click();
  await page.getByRole("option", { name: "100%", exact: true }).click();
  await expect(zoom).toHaveText("100%");
  await zoom.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(zoom).toHaveText("Fit");
  await expect(zoom).toBeFocused();
});
