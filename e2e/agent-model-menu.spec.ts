import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { agentTurn, playSession } from "./agent-turn";
import { configureAgentSessionSchema } from "../src/shared/agent";
import { ProjectSchema } from "../src/shared/project";

async function mockModels(page: Page) {
  let reads = 0;
  await page.route("**/api/cutroom/agents/capabilities?**", (route) => {
    const claude =
      new URL(route.request().url()).searchParams.get("provider") === "claude";
    reads++;
    return route.fulfill({
      json: {
        provider: claude ? "claude" : "codex",
        available: true,
        skills: [],
        models: claude
          ? [{ id: "opus", name: "Opus", efforts: ["low", "high"] }]
          : [
              {
                id: "default",
                name: "GPT Default",
                isDefault: true,
                efforts: ["low", "high"],
              },
              {
                id: "sol",
                name: "GPT-6.2 Sol",
                efforts: ["low", "medium", "high", "xhigh", "max"],
              },
              {
                id: "astra",
                name: "GPT-6.2 Astra",
                efforts: ["low", "medium"],
              },
              { id: "quick", name: "Quick" },
            ],
      },
    });
  });
  return () => reads;
}

test("change model and effort on the open chat with the keyboard", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Model settings" },
      })
    ).json(),
  );
  const turn = agentTurn(project.id);
  let session = {
    ...turn.session([turn.ask, turn.reply], "idle"),
    provider: "codex" as const,
    model: "sol",
    effort: "high" as string | undefined,
  };
  await playSession(page, [session]);
  const reads = await mockModels(page);
  const patches: unknown[] = [];
  await page.route(
    `**/api/cutroom/agents/sessions/${session.id}`,
    async (route) => {
      expect(route.request().method()).toBe("PATCH");
      const body = configureAgentSessionSchema.parse(
        route.request().postDataJSON(),
      );
      patches.push(body);
      if (body.effort === "low") {
        await route.fulfill({
          status: 409,
          json: {
            error: "Stop the current run before changing the model or effort.",
          },
        });
        return;
      }
      session = {
        ...session,
        model: body.model ?? session.model,
        effort: body.model ? undefined : (body.effort ?? undefined),
      };
      await route.fulfill({ json: session });
    },
  );

  await page.goto(`/#project/${project.id}`);
  const trigger = page.getByRole("button", { name: /^Model:/ });
  const menu = page.getByRole("dialog", { name: "Model and effort" });
  const effort = menu.getByRole("radiogroup", { name: "Effort" });
  await expect(trigger).toHaveAccessibleName(
    "Model: Codex, GPT-6.2 Sol, High effort",
  );
  await expect(trigger).toHaveText("6.2 Sol High");
  await expect.poll(reads).toBe(2);
  await trigger.press("ArrowUp");
  const sol = menu.getByRole("option", { name: "GPT-6.2 Sol" });
  const astra = menu.getByRole("option", { name: "GPT-6.2 Astra" });
  await expect(sol).toBeFocused();
  await sol.press("ArrowDown");
  await expect(astra).toBeFocused();
  await astra.press("Enter");
  await expect(trigger).toHaveText("6.2 Astra");
  await astra.press("Tab");
  await expect(effort.getByRole("radio", { name: "Auto" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await expect(trigger).toHaveText("6.2 Astra Medium");
  await expect(effort.getByRole("radio", { name: "Medium" })).toBeChecked();
  expect(patches).toEqual([{ model: "astra" }, { effort: "medium" }]);

  await effort.getByRole("radio", { name: "Low" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Stop the current run before changing the model or effort.",
  );
  await expect(effort.getByRole("radio", { name: "Medium" })).toBeChecked();
  await menu.getByRole("option", { name: "Quick" }).click();
  await expect(trigger).toHaveText("Quick");
  await expect(effort).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(reads()).toBe(2);
});

test("a model from another provider starts a new chat and remembers its choices", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "New chat model" },
      })
    ).json(),
  );
  const turn = agentTurn(project.id);
  const original = {
    ...turn.session([turn.ask, turn.reply], "idle"),
    provider: "codex" as const,
    model: "sol",
    title: "Intro edit",
  };
  await playSession(page, [original]);
  await mockModels(page);
  const newSession = {
    ...turn.session([], "idle"),
    id: crypto.randomUUID(),
    model: "opus",
    effort: "high",
  };
  await page.route("**/api/cutroom/agents/sessions", (route) =>
    route.fulfill({ status: 201, json: newSession }),
  );
  await page.route(
    `**/api/cutroom/agents/sessions/${newSession.id}/turns`,
    (route) => route.fulfill({ status: 202, json: newSession }),
  );
  await page.route(
    `**/api/cutroom/agents/sessions/${newSession.id}/events`,
    (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: `retry: 600000\ndata: ${JSON.stringify({ seq: 0, event: { type: "snapshot", session: newSession } })}\n\n`,
      }),
  );
  await page.goto(`/#project/${project.id}`);
  const trigger = page.getByRole("button", { name: /^Model:/ });
  const menu = page.getByRole("dialog", { name: "Model and effort" });
  const composer = page.getByRole("textbox", { name: "Message your agent" });
  await expect(page.getByText(turn.ask.text)).toBeVisible();
  await trigger.click();
  const claude = menu.getByRole("group", { name: "Claude Code" });
  await expect(claude.getByText("Starts a new chat")).toBeVisible();
  await claude.getByRole("option", { name: "Opus" }).click();
  await expect(menu).toBeHidden();
  await expect(composer).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Chats, New chat" }),
  ).toBeVisible();
  await expect(trigger).toHaveAccessibleName("Model: Claude Code, Opus");
  await expect(page.getByText(turn.reply.text)).toBeHidden();
  await trigger.click();
  await menu.getByRole("radio", { name: "High" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(trigger).toHaveText("Opus High");
  await composer.fill("Shorten the intro.");
  const created = page.waitForRequest(
    (outgoing) =>
      outgoing.method() === "POST" &&
      outgoing.url().endsWith("/agents/sessions"),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  expect((await created).postDataJSON()).toEqual({
    projectId: project.id,
    provider: "claude",
    model: "opus",
    effort: "high",
  });
  await expect(composer).toHaveValue("");
});
