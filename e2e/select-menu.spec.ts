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
  // Tab leaves the menu for the next field, the Size menu.
  await expect(
    dialog.getByRole("combobox", { name: "Size", exact: true }),
  ).toBeFocused();
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

test("chat history, footage and viewer pickers support mouse and keyboard selection", async ({
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
  for (const title of ["First chat", "Second chat"]) {
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
  const chatTitle = page.getByRole("button", { name: /^Chats,/ });
  const chats = page.getByRole("menu", { name: "Chats" });
  await chatTitle.click();
  await chats
    .getByRole("menuitemradio", { name: "First chat", exact: true })
    .click();
  await expect(chatTitle).toHaveText("First chat");
  await expect(chatTitle).toBeFocused();
  await chatTitle.press("Enter");
  await expect(chats).toBeVisible();
  await page.keyboard.press("s");
  await expect(
    chats.getByRole("menuitemradio", { name: "Second chat", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chatTitle).toHaveText("Second chat");
  await expect(chatTitle).toBeFocused();

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
