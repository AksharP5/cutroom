import { expect, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import type { AgentRequest, AgentSession } from "../src/shared/agent";

async function openWaiting(
  page: Page,
  projectId: string,
  request: AgentRequest,
) {
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "claude",
        available: true,
        skills: [],
        models: [],
        mcpServers: [],
      },
    }),
  );
  const now = new Date().toISOString();
  const session: AgentSession = {
    id: crypto.randomUUID(),
    projectId,
    provider: "claude",
    title: "Waiting on you",
    createdAt: now,
    updatedAt: now,
    status: "waiting",
    messages: Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 ? "assistant" : "user",
      text: "A message long enough to take a couple of lines in the transcript.",
      createdAt: now,
      status: "complete",
    })),
    pendingRequest: request,
  };
  await page.route("**/api/cutroom/agents/sessions?**", (route) =>
    route.fulfill({ json: { sessions: [session] } }),
  );
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}/events`,
    (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: `retry: 600000\ndata: ${JSON.stringify({ seq: 0, event: { type: "snapshot", session } })}\n\n`,
      }),
  );
  await page.goto(`/#project/${projectId}`);
}

async function expectInWindow(locator: Locator, page: Page) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(box && box.y >= 0 && box.y + box.height <= height).toBe(true);
}

test("a long agent question keeps its answer and the composer in a short window", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 680 });
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Short window question" },
      })
    ).json(),
  );
  await openWaiting(page, project.id, {
    id: "question-1",
    kind: "question",
    title: "Claude has a question",
    tool: "AskUserQuestion",
    input: {},
    questions: ["Pace", "Music", "Title"].map((topic) => ({
      id: topic,
      question: `How should the ${topic.toLowerCase()} change in the opening?`,
      options: ["Keep it", "Make it faster", "Make it calmer"],
      multiple: false,
    })),
  });
  const question = page.getByRole("region", { name: "Agent question" });
  await expectInWindow(
    question.getByRole("button", { name: "Answer", exact: true }),
    page,
  );
  await expectInWindow(
    question.getByRole("button", { name: "Decline", exact: true }),
    page,
  );
  await expectInWindow(page.getByLabel("Message your agent"), page);
});

test("an approval shows the full target and scoped Always allow in a short window", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 680 });
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Short window approval" },
      })
    ).json(),
  );
  await openWaiting(page, project.id, {
    id: "approval-1",
    canAllowCutroomEdits: true,
    kind: "approval",
    title: "Write compositions/an-unusually-long-composition-name.html?",
    tool: "mcp__cutroom_studio__source_write",
    input: { path: "compositions/an-unusually-long-composition-name.html" },
    target: "compositions/an-unusually-long-composition-name.html",
  });
  const approval = page.getByRole("region", { name: "Permission request" });
  const allow = approval.getByRole("button", { name: "Allow once" });
  await expectInWindow(allow, page);
  const title = approval.getByRole("button", { name: /^Write / });
  const [titleBox, allowBox] = [
    await title.boundingBox(),
    await allow.boundingBox(),
  ];
  expect(titleBox?.height).toBeGreaterThan(16);
  expect((titleBox?.y ?? 0) + (titleBox?.height ?? 0)).toBeLessThanOrEqual(
    allowBox?.y ?? 0,
  );
  expect(
    await title.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expectInWindow(
    approval.getByRole("button", { name: "Always allow Cutroom edits" }),
    page,
  );
  await expectInWindow(page.getByLabel("Message your agent"), page);
});
