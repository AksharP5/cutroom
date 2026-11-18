import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import type { AgentSession } from "../src/shared/agent";

test("A message carries the selected clip and open composition, and the selection route names it", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Agent selection" },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main data-composition-id="main" data-fps="30" data-width="1920" data-height="1080" data-duration="8">
    <div id="headline" class="clip" data-label="Headline" data-start="1" data-duration="3" data-track-index="0">Hello</div>
    <div id="card" class="clip" data-start="4" data-duration="2" data-track-index="1">Card</div>
  </main></body></html>`,
  );
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: true,
        skills: [],
        mcpServers: [],
        models: [{ id: "model-a", name: "Model A", isDefault: true }],
      },
    }),
  );
  const session: AgentSession = {
    id: crypto.randomUUID(),
    projectId: project.id,
    provider: "codex",
    model: "model-a",
    title: "Selection",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [],
  };
  await page.route("**/api/cutroom/agents/sessions?**", (route) =>
    route.fulfill({ json: { sessions: [session] } }),
  );
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}/events`,
    (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ seq: 0, event: { type: "snapshot", session } })}\n\n`,
      }),
  );
  let sent: (context: string) => void = () => {};
  const context = new Promise<string>((resolve) => {
    sent = resolve;
  });
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}/turns`,
    async (route) => {
      sent(route.request().postDataJSON().context);
      await route.fulfill({ status: 202, json: session });
    },
  );

  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="headline"]').click();
  await expect(page.locator('[data-clip="headline"]')).toHaveClass(/selected/);
  await page.getByLabel("Message your agent").fill("Make this bigger");
  await page.getByRole("button", { name: "Send message", exact: true }).click();

  const { editor } = JSON.parse(await context);
  expect(editor.compositionPath).toBe("index.html");
  expect(editor.selectedClips).toEqual([
    { id: "headline", name: "Headline", kind: "element", start: 1, end: 4 },
  ]);

  const published = async () =>
    (await (await request.get(`/api/projects/${project.id}/selection`)).json())
      .selection;
  await expect
    .poll(async () => (await published())?.target)
    .toEqual({ id: "headline", selector: "#headline" });
  expect(await published()).toMatchObject({
    compositionPath: "index.html",
    label: "Headline",
    textContent: "Hello",
  });
  await page.keyboard.press("Escape");
  await expect.poll(published).toBeNull();
});

test("choosing a native skill sends the selected installation when names match", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Native skill selection" },
      })
    ).json(),
  );
  const name = "trim-audio";
  const globalPath = "/example/user/skills/trim-audio/SKILL.md";
  const projectPath = "/example/project/.agents/skills/trim-audio/SKILL.md";
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: true,
        skills: [
          {
            name,
            description: "Trim an audio clip",
            enabled: true,
            path: globalPath,
          },
          {
            name,
            description: "Trim an audio clip",
            enabled: true,
            path: projectPath,
          },
        ],
        mcpServers: [],
        models: [{ id: "model-a", name: "Model A", isDefault: true }],
      },
    }),
  );
  const session: AgentSession = {
    id: crypto.randomUUID(),
    projectId: project.id,
    provider: "codex",
    model: "model-a",
    title: "Native skill selection",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [],
  };
  await page.route("**/api/cutroom/agents/sessions?**", (route) =>
    route.fulfill({ json: { sessions: [session] } }),
  );
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}/events`,
    (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ seq: 0, event: { type: "snapshot", session } })}\n\n`,
      }),
  );
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}/turns`,
    (route) => route.fulfill({ status: 202, json: session }),
  );

  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  const message = page.getByLabel("Message your agent");
  await message.fill("$trim");
  const options = page
    .getByRole("listbox", { name: "Skills" })
    .getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText(globalPath);
  await expect(options.nth(1)).toContainText(projectPath);
  await page.getByRole("complementary", { name: "Agent" }).screenshot({
    path: info.outputPath("duplicate-skills.png"),
  });
  await message.fill("$tri the narration");
  await message.evaluate((input: HTMLTextAreaElement) =>
    input.setSelectionRange(4, 4),
  );
  await message.pressSequentially("m");
  const inserted = await options
    .nth(1)
    .evaluate(async (option: HTMLElement) => {
      const input = document.activeElement;
      if (!(input instanceof HTMLTextAreaElement))
        throw new Error("Composer lost focus");
      option.click();
      // React commits the edit before the browser's next animation frame.
      await Promise.resolve();
      return { text: input.value, caret: input.selectionStart };
    });
  expect(inserted).toEqual({ text: "$trim-audio  the narration", caret: 12 });
  await message.pressSequentially("shorten");
  await page.reload();
  if (!(await message.isVisible()))
    await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(message).toHaveValue("$trim-audio shorten the narration");
  const sent = page.waitForRequest(
    (outgoing) =>
      outgoing.method() === "POST" && outgoing.url().endsWith("/turns"),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  expect((await sent).postDataJSON()).toMatchObject({
    text: "$trim-audio shorten the narration",
    skills: [{ name, path: projectPath }],
  });

  await expect(message).toHaveValue("");
  await message.fill("$trim-audio shorten the next clip");
  const typed = page.waitForRequest(
    (outgoing) =>
      outgoing.method() === "POST" && outgoing.url().endsWith("/turns"),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  expect((await typed).postDataJSON()).toMatchObject({
    text: "$trim-audio shorten the next clip",
    skills: [{ name, path: globalPath }],
  });
});
