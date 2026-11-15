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
