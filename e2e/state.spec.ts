import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import type { AgentSession } from "../src/shared/agent";
import { embeddedEditor } from "./embedded";

async function agentConfiguration(page: Page) {
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: true,
        skills: [],
        models: [],
        mcpServers: [],
      },
    }),
  );
}

test("changing projects closes a saved review frame and clears project-local review state", async ({
  page,
  request,
}) => {
  await agentConfiguration(page);
  const first = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Review project one" },
      })
    ).json(),
  );
  const second = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Review project two" },
      })
    ).json(),
  );
  const capture = await request.post(
    `/api/cutroom/projects/${first.id}/attachments`,
    {
      data: {
        image:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2V8AAAAASUVORK5CYII=",
      },
    },
  );
  const frame = (await capture.json()) as { path: string };
  expect(
    (
      await request.post(`/api/cutroom/projects/${first.id}/annotations`, {
        data: {
          kind: "comment",
          body: "Only in project one",
          time: 0,
          framePath: frame.path,
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/#project/${first.id}`);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "View annotated frame" }).click();
  await expect(
    page.getByRole("dialog", { name: "Review at 00:00:00:00" }),
  ).toBeVisible();
  await page.evaluate((id) => {
    location.hash = `project/${id}`;
  }, second.id);
  await expect(
    page.getByRole("button", { name: "Review project two", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("Only in project one", { exact: true }),
  ).toHaveCount(0);
});

test("an in-flight agent submission cannot switch conversations or erase the next draft", async ({
  page,
  request,
}) => {
  await agentConfiguration(page);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Chat admission" },
      })
    ).json(),
  );
  const session: AgentSession = {
    id: crypto.randomUUID(),
    projectId: project.id,
    provider: "codex",
    title: "A request",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [],
  };
  await page.route("**/api/cutroom/agents/sessions?**", (route) =>
    route.fulfill({ json: { sessions: [] } }),
  );
  await page.route("**/api/cutroom/agents/sessions", (route) =>
    route.fulfill({ status: 201, json: session }),
  );
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}/events`,
    (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ seq: 0, event: { type: "snapshot", session } })}\n\n`,
      }),
  );
  let release = () => {};
  const accepted = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}/turns`,
    async (route) => {
      entered();
      await accepted;
      await route.fulfill({ status: 202, json: session });
    },
  );
  try {
    await page.goto(`/#project/${project.id}`);
    const composer = page.getByLabel("Message your agent");
    await composer.fill("First request");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await pending;
    await expect(
      page.getByLabel("Agent provider", { exact: true }),
    ).toBeDisabled();
    // While a turn is in flight, the presence line replaces the conversation controls.
    await expect(page.getByLabel("Conversation", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "New conversation", exact: true }),
    ).toHaveCount(0);
    await composer.fill("The next request");
    release();
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
    await expect(composer).toHaveValue("The next request");
  } finally {
    release();
  }
});

test("a transcription job survives leaving its project and retries a temporary polling failure", async ({
  page,
  request,
}) => {
  await agentConfiguration(page);
  const first = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Transcription one" },
      })
    ).json(),
  );
  const second = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Transcription two" },
      })
    ).json(),
  );
  await page.route(`**/api/cutroom/projects/${first.id}/media`, (route) =>
    route.fulfill({
      json: {
        media: [
          {
            elementId: "speech",
            mediaPath: "speech.wav",
            sourceFile: "index.html",
            label: "Speech",
            kind: "audio",
            start: 0,
            duration: 12,
          },
        ],
      },
    }),
  );
  const job = {
    id: crypto.randomUUID(),
    projectId: first.id,
    status: "running",
    message: "Transcribing project one",
    progress: 0.1,
  };
  await page.route(`**/api/cutroom/projects/${first.id}/transcribe`, (route) =>
    route.fulfill({ status: 202, json: job }),
  );
  let polls = 0;
  let failNext = false;
  let finish = false;
  await page.route(`**/api/cutroom/transcription-jobs/${job.id}`, (route) => {
    if (route.request().method() === "DELETE")
      return route.fulfill({ json: { ...job, status: "cancelled" } });
    polls++;
    if (failNext) {
      failNext = false;
      finish = true;
      return route.fulfill({
        status: 503,
        json: { error: "Temporary interruption" },
      });
    }
    return route.fulfill({
      json: finish ? { ...job, status: "cancelled" } : job,
    });
  });
  await page.goto(`/#project/${first.id}`);
  await page.getByRole("button", { name: "Script", exact: true }).click();
  await page
    .getByRole("button", { name: "Transcribe locally", exact: true })
    .click();
  await expect(
    page.getByText("Transcribing project one", { exact: true }),
  ).toBeVisible();
  await page.evaluate((id) => {
    location.hash = `project/${id}`;
  }, second.id);
  await expect(
    page.getByRole("button", { name: second.name, exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#project/${second.id}(?:\\?|$)`));
  await expect(
    page.getByText("Transcribing project one", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate((id) => {
    location.hash = `project/${id}`;
  }, first.id);
  await expect(
    page.getByRole("button", { name: first.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Transcribing project one", { exact: true }),
  ).toBeVisible();
  failNext = true;
  const before = polls;
  await expect(
    page.getByRole("button", { name: "Transcribe locally", exact: true }),
  ).toBeEnabled({ timeout: 10000 });
  expect(polls).toBeGreaterThan(before + 1);
  await page.goBack();
  await expect(
    page.getByRole("button", { name: second.name, exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("button", { name: first.name, exact: true }),
  ).toBeVisible();
});

test("streamed deltas remain ordered through the final idle event", async ({
  page,
  request,
}) => {
  await agentConfiguration(page);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Streaming order" },
      })
    ).json(),
  );
  const messageId = crypto.randomUUID();
  const session: AgentSession = {
    id: crypto.randomUUID(),
    projectId: project.id,
    provider: "codex",
    title: "Streamed response",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    messages: [
      {
        id: messageId,
        role: "assistant",
        text: "",
        status: "streaming",
        createdAt: new Date().toISOString(),
      },
    ],
  };
  await page.route("**/api/cutroom/agents/sessions?**", (route) =>
    route.fulfill({ json: { sessions: [session] } }),
  );
  const deltas = Array.from({ length: 40 }, (_, index) => `word${index} `);
  const events = [
    { type: "snapshot", session },
    ...deltas.map((text) => ({ type: "delta", messageId, text })),
    { type: "status", status: "idle" },
  ];
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}/events`,
    (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: events
          .map((event, seq) => `data: ${JSON.stringify({ seq, event })}\n\n`)
          .join(""),
      }),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".message-assistant .markdown")).toHaveText(
    deltas.join("").trim(),
  );
  await expect(
    page.getByRole("button", { name: "New conversation", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await expect(page.locator(".message-assistant")).toHaveCount(0);
});

test("a frame capture finishing in an old project cannot clear a new project's draft", async ({
  page,
  request,
}) => {
  await embeddedEditor(page);
  await agentConfiguration(page);
  const first = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Capture one" },
      })
    ).json(),
  );
  const second = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Capture two" },
      })
    ).json(),
  );
  await page.goto(`/#project/${first.id}`);
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });
  let release = () => {};
  const captured = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route(
    `**/api/projects/${first.id}/thumbnail/**`,
    async (route) => {
      if (route.request().resourceType() !== "fetch") return route.fallback();
      entered();
      await captured;
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from(image, "base64"),
      });
    },
  );
  try {
    await page
      .getByRole("button", { name: "Comment (C)", exact: true })
      .click();
    await page
      .getByLabel("Pin a comment on the composition")
      .click({ position: { x: 50, y: 50 } });
    await page
      .getByLabel("What should change?", { exact: true })
      .fill("The first project's saved note");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await started;
    await page.evaluate((id) => {
      location.hash = `project/${id}`;
    }, second.id);
    await expect(
      page.getByRole("button", { name: "Capture two", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Comment (C)", exact: true })
      .click();
    await page
      .getByLabel("Pin a comment on the composition")
      .click({ position: { x: 80, y: 70 } });
    const draft = page.getByLabel("What should change?", { exact: true });
    await draft.fill("Keep the second project's draft");
    release();
    await expect
      .poll(async () => {
        const document = (await (
          await request.get(`/api/cutroom/projects/${first.id}/document`)
        ).json()) as { annotations: unknown[] };
        return document.annotations.length;
      })
      .toBe(1);
    await expect(draft).toHaveValue("Keep the second project's draft");
  } finally {
    release();
  }
});
