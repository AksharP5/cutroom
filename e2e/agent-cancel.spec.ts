import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import type { AgentSession } from "../src/shared/agent";

async function configureAgent(page: Page) {
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: true,
        skills: [],
        mcpServers: [],
        models: [
          { id: "model-a", name: "Model A", isDefault: true },
          { id: "model-b", name: "Model B" },
        ],
      },
    }),
  );
}

function sessionFor(projectId: string): AgentSession {
  return {
    id: crypto.randomUUID(),
    projectId,
    provider: "codex",
    model: "model-a",
    title: "Prepared request",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [],
  };
}

test("Stop cancels turn preparation, keeps the draft, and does not appear for model changes", async ({
  page,
  request,
}) => {
  await configureAgent(page);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Stop preparation" },
      })
    ).json(),
  );
  let session = sessionFor(project.id);
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
  let changed = () => {};
  const modelChanged = new Promise<void>((resolve) => {
    changed = resolve;
  });
  let patchEntered = () => {};
  const modelPending = new Promise<void>((resolve) => {
    patchEntered = resolve;
  });
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}`,
    async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      patchEntered();
      await modelChanged;
      session = { ...session, model: "model-b" };
      await route.fulfill({ json: session });
    },
  );
  let release = () => {};
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}/turns`,
    async (route) => {
      started();
      await finished;
      await route.fulfill({ status: 202, json: session });
    },
  );
  let interrupts = 0;
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}/interrupt`,
    async (route) => {
      interrupts++;
      release();
      await route.fulfill({ json: session });
    },
  );
  try {
    await page.goto(`/#project/${project.id}`);
    await expect(page.getByLabel("Model", { exact: true })).toBeEnabled();
    await page.getByLabel("Model", { exact: true }).click();
    await page.getByRole("option", { name: "Model B", exact: true }).click();
    await modelPending;
    await expect(
      page.getByRole("button", { name: "Stop agent", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("Saving model", { exact: true })).toBeVisible();
    changed();
    const composer = page.getByLabel("Message your agent");
    await composer.fill("Preserve this cancelled request");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await pending;
    await page.getByRole("button", { name: "Stop agent", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "New conversation", exact: true }),
    ).toBeEnabled();
    await expect(composer).toHaveValue("Preserve this cancelled request");
    expect(interrupts).toBe(1);
  } finally {
    changed();
    release();
  }
});

test("Stop during conversation creation prevents a late response from starting a turn", async ({
  page,
  request,
}) => {
  await configureAgent(page);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Stop before a session exists" },
      })
    ).json(),
  );
  const session = sessionFor(project.id);
  await page.route("**/api/cutroom/agents/sessions?**", (route) =>
    route.fulfill({ json: { sessions: [] } }),
  );
  let release = () => {};
  const created = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route("**/api/cutroom/agents/sessions", async (route) => {
    entered();
    await created;
    await route.fulfill({ status: 201, json: session });
  });
  let turns = 0;
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}/turns`,
    async (route) => {
      turns++;
      await route.fulfill({ status: 202, json: session });
    },
  );
  try {
    await page.goto(`/#project/${project.id}`);
    const composer = page.getByLabel("Message your agent");
    await composer.fill("Keep this unsent text");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await pending;
    await page.getByRole("button", { name: "Stop agent", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/cutroom/agents/sessions"),
    );
    release();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(composer).toHaveValue("Keep this unsent text");
    expect(turns).toBe(0);
  } finally {
    release();
  }
});
