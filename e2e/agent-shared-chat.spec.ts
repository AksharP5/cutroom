import { expect, test } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";
import type { AgentSession } from "../src/shared/agent";
import { ProjectSchema } from "../src/shared/project";
import { agentTurn } from "./agent-turn";

const at = new Date().toISOString();

async function sharedChat(page: Page, request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Shared chats" },
      })
    ).json(),
  );
  const base = `**/api/cutroom/projects/${project.id}`;
  const chats = new Map<string, AgentSession>();
  const turn = agentTurn(project.id);
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: { provider: "codex", available: true, models: [], skills: [] },
    }),
  );
  await page.route("**/api/cutroom/agents/sessions?**", (route) =>
    route.fulfill({ json: { sessions: [...chats.values()] } }),
  );
  await page.route("**/api/cutroom/agents/sessions/*/events", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    const session = chats.get(id);
    if (!session) throw new Error(`No synthetic chat for ${id}`);
    return route.fulfill({
      contentType: "text/event-stream",
      body: `retry: ${session.t3Thread && session.status === "running" ? 100 : 600_000}\ndata: ${JSON.stringify({ seq: 0, event: { type: "snapshot", session } })}\n\n`,
    });
  });
  const panel = page.getByRole("complementary", { name: "Agent chat" });
  const title = panel.getByRole("button", { name: /^Chats,/ });
  const menu = panel.getByRole("menu", { name: "Chats" });
  const composer = panel.getByRole("textbox", { name: "Message your agent" });
  return {
    base,
    chats,
    turn,
    panel,
    title,
    menu,
    composer,
    url: `/#project/${project.id}`,
  };
}

test("link a folder thread with the keyboard and send while T3 Code works", async ({
  page,
  request,
}) => {
  const { base, chats, turn, panel, title, menu, composer, url } =
    await sharedChat(page, request);
  const thread = {
    threadId: "folder-thread",
    title: "Opening shot and music mix with a title long enough to truncate",
    status: "running",
    model: "gpt-5.4",
    updatedAt: at,
  };
  const linked = {
    ...turn.session([turn.ask, turn.plan], "running"),
    title: thread.title,
    t3Thread: { threadId: thread.threadId },
  };
  let listings = 0;
  let links = 0;
  await page.route(`${base}/t3-threads`, (route) => {
    listings++;
    return route.fulfill({ json: { available: true, threads: [thread] } });
  });
  await page.route(`${base}/t3-threads/link`, (route) => {
    links++;
    expect(route.request().postDataJSON()).toEqual({
      threadId: thread.threadId,
    });
    chats.set(linked.id, linked);
    return route.fulfill({ status: 201, json: linked });
  });
  await page.route(
    `**/api/cutroom/agents/sessions/${linked.id}/turns`,
    (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        text: "Try a slower transition. $literal",
        skills: [],
      });
      const waiting = { ...linked, status: "waiting" } satisfies AgentSession;
      chats.set(linked.id, waiting);
      return route.fulfill({ status: 202, json: { ...waiting, queued: true } });
    },
  );

  await page.goto(url);
  // The title is disabled while the project's chats load; a key sent before then is lost.
  await expect(title).toBeEnabled();
  await title.press("Enter");
  const entry = menu.getByRole("menuitem", { name: "Link a T3 Code thread" });
  await expect(entry).toBeVisible();
  expect(listings).toBe(0);
  await menu.getByRole("menuitem", { name: "New chat" }).press("ArrowDown");
  await expect(entry).toBeFocused();
  await entry.press("Enter");
  const back = menu.getByRole("menuitem", { name: "Chats", exact: true });
  const row = menu.getByRole("menuitem", { name: thread.title });
  await expect(back).toBeFocused();
  await expect(row).toBeVisible();
  await back.press("ArrowDown");
  await expect(row).toBeFocused();
  await row.press("Escape");
  await expect(entry).toBeFocused();
  await entry.press("Enter");
  await expect(row).toBeVisible();
  await row.press("Enter");

  await expect(menu).toBeHidden();
  await expect(title).toBeFocused();
  await expect(panel.getByText("T3 Code", { exact: true })).toBeVisible();
  await expect(panel.getByText("Working in T3 Code")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Stop agent" })).toHaveCount(
    0,
  );
  await expect(panel.locator(".presence-clock")).toHaveCount(0);
  // Cutroom never opens a hosted page: a linked chat offers no link out.
  await expect(panel.getByRole("link")).toHaveCount(0);

  await composer.fill("Try a slower transition. $literal");
  await panel.getByRole("button", { name: "Send to T3 Code" }).click();
  await expect(panel.getByText("Queued in T3 Code")).toBeVisible();
  await expect(
    panel.getByText("Answer in T3 Code", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("region", { name: "Queued follow-ups" }),
  ).toHaveCount(0);
  await title.click();
  await entry.click();
  await expect(row.getByText("Linked")).toBeVisible();
  await row.click();
  await expect(
    panel.getByText("Answer in T3 Code", { exact: true }),
  ).toBeVisible();
  expect(links).toBe(1);
});

test("paste a thread ID and recover from a rejected ID", async ({
  page,
  request,
}) => {
  const { base, chats, turn, panel, title, menu, url } = await sharedChat(
    page,
    request,
  );
  await page.route(`${base}/t3-threads`, (route) =>
    route.fulfill({ json: { available: true, threads: [] } }),
  );
  const linked = {
    ...turn.session([turn.ask], "idle"),
    title: "A thread in another folder",
    t3Thread: { threadId: "other-folder" },
  };
  await page.route(`${base}/t3-threads/link`, (route) => {
    if (route.request().postDataJSON().threadId !== linked.t3Thread.threadId)
      return route.fulfill({
        status: 404,
        json: { error: "T3 Code could not find this thread." },
      });
    chats.set(linked.id, linked);
    return route.fulfill({ status: 201, json: linked });
  });

  await page.goto(url);
  await title.click();
  await menu.getByRole("menuitem", { name: "Link a T3 Code thread" }).click();
  await expect(
    menu.getByText("No T3 Code threads for this folder."),
  ).toBeVisible();
  await menu.getByRole("menuitem", { name: "Chats", exact: true }).press("Tab");
  const field = menu.getByRole("textbox", { name: "Paste a thread ID" });
  await expect(field).toBeFocused();
  await field.pressSequentially("missing-folder");
  await field.press("Enter");
  await expect(menu.getByRole("alert")).toHaveText(
    "T3 Code could not find this thread.",
  );
  await field.fill("other-folder");
  await field.press("Enter");
  await expect(title).toHaveText(linked.title);
  await expect(panel.getByText(turn.ask.text)).toBeVisible();
});

test("continue a terminal chat and branch after a refused send without losing the draft", async ({
  page,
  request,
}) => {
  const { base, chats, turn, panel, title, menu, composer, url } =
    await sharedChat(page, request);
  const terminal = {
    provider: "codex",
    id: "terminal-session",
    title: "Cut the music at the last frame",
    updatedAt: at,
  };
  const imported = {
    ...turn.session(
      [
        ...Array.from({ length: 199 }, (_, index) => ({
          ...turn.plan,
          id: `imported-${index}`,
          text: `Previous line ${index + 1}`,
        })),
        turn.reply,
      ],
      "idle",
    ),
    provider: "codex",
    title: terminal.title,
    nativeSessionId: terminal.id,
    nativeImport: { mode: "continue", omittedMessages: 17 },
  } satisfies AgentSession;
  const branched = {
    ...imported,
    id: crypto.randomUUID(),
    title: "Branched music edit",
    messages: [turn.reply],
    nativeImport: { mode: "branch", omittedMessages: 0 },
  } satisfies AgentSession;
  await page.route(`${base}/native-sessions`, (route) =>
    route.fulfill({
      json: {
        sessions: chats.has(imported.id) ? [] : [terminal],
        unavailable: [
          { provider: "claude", reason: "Claude Code is unavailable." },
        ],
      },
    }),
  );
  for (const [mode, session] of [
    ["continue", imported],
    ["branch", branched],
  ] as const)
    await page.route(`${base}/native-sessions/${mode}`, (route) => {
      expect(route.request().postDataJSON()).toEqual({
        provider: terminal.provider,
        sessionId: terminal.id,
      });
      chats.set(session.id, session);
      return route.fulfill({ status: 201, json: session });
    });
  const refusal = "This session changed outside Cutroom. Wait or branch it.";
  await page.route(
    `**/api/cutroom/agents/sessions/${imported.id}/turns`,
    (route) =>
      route.fulfill({
        status: 409,
        json: { error: refusal, code: "native_session_conflict" },
      }),
  );

  await page.goto(url);
  await title.click();
  await menu.getByRole("menuitem", { name: "Continue a session" }).click();
  await expect(menu.getByText("Claude Code is unavailable.")).toHaveCount(1);
  await menu
    .getByRole("group", { name: "Codex" })
    .getByRole("menuitem", { name: terminal.title })
    .click();
  const firstLine = panel.getByText("Showing the latest 200 messages");
  await expect(firstLine).toBeVisible();
  await expect(panel.getByText("Previous line 199")).toBeVisible();
  await composer.fill("Try one more frame.");
  await panel.getByRole("button", { name: "Send message" }).click();
  const alert = panel.getByRole("alert");
  await expect(alert.getByText(refusal)).toBeVisible();
  await alert.getByRole("button", { name: "Branch" }).click();
  await expect(title).toHaveText(branched.title);
  await expect(composer).toHaveValue("Try one more frame.");
  await expect(composer).toBeFocused();
  await expect(firstLine).toHaveCount(0);

  await page.route(`**/api/cutroom/agents/sessions/${imported.id}`, (route) => {
    expect(route.request().method()).toBe("DELETE");
    chats.delete(imported.id);
    return route.fulfill({ json: { deleted: true } });
  });
  await title.click();
  const continuedRow = menu.getByRole("menuitemradio", {
    name: terminal.title,
  });
  await continuedRow.press("Delete");
  await menu.getByRole("button", { name: "Delete", exact: true }).click();
  await menu.getByRole("menuitem", { name: "Continue a session" }).click();
  const offeredAgain = menu.getByRole("menuitem", { name: terminal.title });
  await offeredAgain.focus();
  const branch = menu.getByRole("menuitem", { name: "Branch" });
  await offeredAgain.press("Tab");
  await expect(branch).toBeFocused();
  await offeredAgain.press("b");
  await expect(menu).toBeHidden();
});
