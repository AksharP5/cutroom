import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { agentSessionSchema } from "../src/shared/agent";
import { ProjectSchema } from "../src/shared/project";
import { agentTurn } from "./agent-turn";

async function mockCapabilities(page: Page) {
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: true,
        models: [],
        skills: [],
      },
    }),
  );
}

test("switching away keeps a live chat running and remembers the selected chat", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Switching chats" },
      })
    ).json(),
  );
  const turn = agentTurn(project.id);
  const working = {
    ...turn.session([turn.ask, turn.plan], "running"),
    title: "Intro edit",
  };
  const idle = {
    ...turn.session([{ ...turn.ask, text: "Bring up the music." }], "idle"),
    id: crypto.randomUUID(),
    title: "Music mix",
  };
  const chats = [working, idle];
  await mockCapabilities(page);
  await page.route("**/api/cutroom/agents/sessions?**", (route) =>
    route.fulfill({ json: { sessions: chats } }),
  );
  for (const session of chats)
    await page.route(
      `**/api/cutroom/agents/sessions/${session.id}/events`,
      (route) =>
        route.fulfill({
          contentType: "text/event-stream",
          body: `retry: 600000\ndata: ${JSON.stringify({ seq: 0, event: { type: "snapshot", session } })}\n\n`,
        }),
    );
  const refusal =
    "Another chat in this project is already working. Stop it or wait for it to finish.";
  await page.route(`**/api/cutroom/agents/sessions/${idle.id}/turns`, (route) =>
    route.fulfill({ status: 409, json: { error: refusal } }),
  );

  await page.goto(`/#project/${project.id}`);
  const chat = page.getByRole("complementary", { name: "Agent chat" });
  const title = chat.getByRole("button", { name: /^Chats,/ });
  const menu = chat.getByRole("menu", { name: "Chats" });
  const stop = chat.getByRole("button", { name: "Stop agent" });
  const intro = menu.getByRole("menuitemradio", { name: working.title });
  const music = menu.getByRole("menuitemradio", { name: idle.title });
  await expect(stop).toBeVisible();

  await title.press("Enter");
  await expect(intro).toBeFocused();
  await expect(intro.getByRole("img", { name: "Working" })).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Delete chat" }),
  ).toHaveAttribute("title", "Stop the run first");
  await expect(
    menu.getByRole("menuitem", { name: "Refresh agents" }),
  ).toBeDisabled();
  await intro.press("ArrowDown");
  await expect(music).toBeFocused();
  await music.press("Enter");
  await expect(menu).toBeHidden();
  await expect(chat.getByText("Bring up the music.")).toBeVisible();
  await expect(stop).toBeHidden();
  const composer = chat.getByRole("textbox", { name: "Message your agent" });
  await composer.fill("Take it a little higher.");
  await chat.getByRole("button", { name: "Send message" }).click();
  await expect(chat.getByRole("alert")).toHaveText(refusal);

  await page.reload();
  await expect(chat.getByText("Bring up the music.")).toBeVisible();
  await title.press("ArrowDown");
  await expect(music).toBeFocused();
  await music.press("Escape");
  await expect(menu).toBeHidden();
  await expect(title).toBeFocused();

  await chat.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(composer).toBeFocused();
  const recent = chat.getByRole("region", { name: "Recent" });
  await expect(recent.getByRole("button")).toHaveCount(2);
  await recent.getByRole("button", { name: /Intro edit/ }).click();
  await expect(stop).toBeVisible();
});

test("rename and confirm deletion in the list using the real chat API", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Manage chats" },
      })
    ).json(),
  );
  const other = "Sound pass";
  const name = "Colour correction";
  for (const title of [other, name]) {
    const response = await request.post("/api/cutroom/agents/sessions", {
      data: { projectId: project.id, provider: "codex", title },
    });
    expect(response.status()).toBe(201);
    agentSessionSchema.parse(await response.json());
  }
  await mockCapabilities(page);
  await page.goto(`/#project/${project.id}`);
  const chat = page.getByRole("complementary", { name: "Agent chat" });
  const title = chat.getByRole("button", { name: /^Chats,/ });
  const menu = chat.getByRole("menu", { name: "Chats" });

  await expect(title).toBeEnabled();
  await title.press("Space");
  const original = menu.getByRole("menuitemradio", { name });
  await original.click();
  await title.press("Space");
  await expect(original).toBeFocused();
  await original.press("Tab");
  const renameAction = menu.getByRole("menuitem", { name: "Rename chat" });
  await expect(renameAction).toBeFocused();
  await renameAction.press("Enter");
  const field = menu.getByRole("textbox", { name: "Chat title" });
  await expect(field).toBeFocused();
  await field.fill("   ");
  await field.press("Enter");
  await expect(field).toBeVisible();
  await field.press("Escape");
  await expect(original).toBeFocused();
  await original.press("F2");
  await field.fill("Grading the interview");
  await field.press("Enter");
  const renamed = menu.getByRole("menuitemradio", {
    name: "Grading the interview",
  });
  await expect(renamed).toBeFocused();
  await expect(title).toHaveAccessibleName("Chats, Grading the interview");

  await renamed.press("Delete");
  await expect(menu.getByText("Delete this chat?")).toBeVisible();
  await menu.getByRole("button", { name: "Cancel" }).click();
  await expect(renamed).toBeFocused();
  await renamed.press("Delete");
  await menu.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(renamed).toHaveCount(0);
  await expect(title).toHaveAccessibleName(`Chats, ${other}`);
  await menu.getByRole("menuitemradio", { name: other }).press("Delete");
  await menu.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(title).toHaveAccessibleName("Chats, New chat");
  await expect(
    chat.getByRole("textbox", { name: "Message your agent" }),
  ).toBeFocused();
});
