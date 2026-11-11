import { expect, test } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import type { AgentRequest } from "../src/shared/agent";
import { agentTurn, playSession } from "./agent-turn";

async function createProject(request: APIRequestContext, name: string) {
  return ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", { data: { name } })
    ).json(),
  );
}

const rows = (page: Page) => page.locator(".chat-step");
/** A row's one line: its verb, what it acted on, and whether it failed. */
const line = (page: Page, index: number) =>
  rows(page).nth(index).locator("summary");
/** Where the summary line sits in the transcript, whatever the panel's entrance transform is doing. */
const place = (page: Page) =>
  page.locator(".chat-steps").evaluate((element) => {
    const transcript = element.closest(".chat-messages");
    if (!transcript) return null;
    const line = element.getBoundingClientRect();
    return {
      top: Math.round(
        line.top -
          transcript.getBoundingClientRect().top +
          transcript.scrollTop,
      ),
      height: Math.round(line.height),
    };
  });

test("a turn's tool calls fold into one step group that counts in place, with failures and edits kept in view", async ({
  page,
  request,
}) => {
  const project = await createProject(request, "Step groups");
  const turn = agentTurn(project.id);
  const until = (count: number, running?: number) =>
    turn.session(
      [
        turn.ask,
        turn.plan,
        ...turn.steps
          .slice(0, count)
          .map((step, index) =>
            index === running
              ? { ...step, status: "streaming" as const }
              : step,
          ),
      ],
      "running",
    );
  const session = await playSession(page, [
    // Reading the third file.
    until(6, 5),
    // The failed command is back and the timeline edit is running.
    until(13, 12),
    turn.session([turn.ask, turn.plan, ...turn.steps, turn.reply], "idle"),
  ]);
  await page.goto(`/#project/${project.id}`);

  const group = page.getByRole("group", { name: "Agent steps" });
  const summary = group.getByRole("button");
  await expect(summary).toHaveText(
    "Reading 3 files, checked the project, 1 more",
  );
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  // Nothing went wrong and nothing changed yet, so the summary is the whole group.
  await expect(rows(page)).toHaveCount(0);
  const before = await place(page);
  await summary.evaluate((element) => element.setAttribute("data-probe", ""));

  await session.advance();
  await expect(summary).toHaveText("Read 6 files, ran 2 commands, 3 more");
  // The same line updated: it did not move, resize, or get replaced.
  expect(await place(page)).toEqual(before);
  await expect(summary).toHaveAttribute("data-probe", "");
  await expect(rows(page)).toHaveCount(2);
  await expect(line(page, 0)).toHaveText(
    "Ran npx --no-install hyperframes validate Failed",
  );
  await expect(rows(page).nth(0).locator(".chat-tool-reason")).toHaveText(
    /^npm error npx canceled due to missing packages/,
  );
  await expect(line(page, 1)).toHaveText("Editing Lower third");

  await session.advance();
  await expect(summary).toHaveText("Read 6 files, ran 2 commands, 7 more");
  expect(await place(page)).toEqual(before);
  await expect(line(page, 1)).toHaveText("Edited Lower third");
  await expect(
    page.getByText("Applied the note. The lower third slides in twice as fast"),
  ).toBeVisible();
  // One group for the whole segment, between the plan and the reply.
  await expect(page.getByRole("group", { name: "Agent steps" })).toHaveCount(1);

  // The keyboard opens the raw rows, in the order they ran, and closes them again.
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  await expect(rows(page)).toHaveCount(turn.steps.length);
  await expect(line(page, 1)).toHaveText(
    "Started “Speed up the lower third's slide-in and hold it…”",
  );
  await expect(line(page, 3)).toHaveText("Read index.html");
  // A row still opens to its full output.
  await line(page, 10).click();
  await expect(rows(page).nth(10).locator("pre")).toContainText(
    "A complete log of this run can be found in",
  );
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(rows(page)).toHaveCount(2);
});

test("an approval asks in plain words, keeps ids and tool names out of sight, and answers from the keyboard", async ({
  page,
  request,
}) => {
  const project = await createProject(request, "Plain approvals");
  const turn = agentTurn(project.id);
  const noteId = "9833c4fb-2f39-49af-bab0-30d39bfda8ed";
  const tool = "mcp__cutroom_studio__timeline_edit";
  const pending: AgentRequest = {
    id: "approval-1",
    kind: "approval",
    title: "Edit Lower third?",
    detail: "2 changes",
    target: "Lower third",
    tool,
    canAllowCutroomEdits: true,
    input: {
      projectId: project.id,
      composition: "index.html",
      expectedRevision: "c0ffee",
      noteId,
      commands: [
        { type: "trim", clipId: "lt-7f3a", edge: "end", to: 180 },
        { type: "setClip", clipId: "lt-7f3a", fadeIn: 9 },
      ],
    },
  };
  const waiting = {
    ...turn.session(
      [
        turn.ask,
        turn.plan,
        ...turn.steps.slice(0, 12),
        { ...turn.edit, status: "streaming" as const },
      ],
      "waiting",
    ),
    pendingRequest: pending,
  };
  await playSession(page, [waiting]);
  let answered: unknown;
  await page.route(
    `**/api/cutroom/agents/sessions/${waiting.id}/responses`,
    async (route) => {
      answered = route.request().postDataJSON();
      await route.fulfill({ json: waiting });
    },
  );
  await page.goto(`/#project/${project.id}`);

  const approval = page.getByRole("region", { name: "Permission request" });
  await expect(approval).toContainText("Edit Lower third?");
  await expect(approval).toContainText("2 changes");
  // The region is described by its question for a screen reader.
  await expect(approval).toHaveAccessibleDescription("Edit Lower third?");
  const shown = await approval.innerText();
  for (const raw of [tool, "cutroom_studio", noteId, project.id, "lt-7f3a"])
    expect(shown).not.toContain(raw);

  // Tab walks the controls in the order they read.
  const allow = approval.getByRole("button", { name: "Allow once" });
  await allow.focus();
  for (const name of ["Deny", "Details", "Always allow Cutroom edits"]) {
    await page.keyboard.press("Tab");
    await expect(approval.getByRole("button", { name })).toBeFocused();
  }
  // The lasting grant says what it covers in the same sentence.
  await expect(approval.locator(".agent-request-scope")).toHaveText(
    "Always allow Cutroom edits for this project, in every conversation, until you revoke. Shell and native file changes still ask.",
  );
  // The exact request is still there for anyone who asks for it.
  const details = approval.getByRole("button", { name: "Details" });
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(approval.locator("pre")).toContainText(tool);
  await expect(approval.locator("pre")).toContainText(noteId);
  await page.keyboard.press("Enter");
  await expect(approval.locator("pre")).toHaveCount(0);

  await approval.getByRole("button", { name: "Deny" }).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => answered)
    .toMatchObject({
      requestId: "approval-1",
      decision: "deny",
    });
});

test("a command approval shows the whole command below a plain question", async ({
  page,
  request,
}) => {
  const project = await createProject(request, "Command approvals");
  const turn = agentTurn(project.id);
  const command =
    "npx --no-install hyperframes validate compositions/lower-third.html --strict --reporter json";
  const waiting = {
    ...turn.session([turn.ask, turn.plan], "waiting"),
    pendingRequest: {
      id: "approval-2",
      kind: "approval",
      title: "Run this command?",
      target: command,
      tool: "Bash",
      input: { command },
    } satisfies AgentRequest,
  };
  await playSession(page, [waiting]);
  await page.goto(`/#project/${project.id}`);
  const approval = page.getByRole("region", { name: "Permission request" });
  await expect(approval.locator(".agent-request-title")).toHaveText(
    "Run this command?",
  );
  const shell = approval.locator(".agent-request-command");
  await expect(shell).toHaveText(command);
  // Wrapped, never cut off: the command is what is being approved.
  expect(
    await shell.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  // Only Cutroom's own edits can be allowed for good.
  await expect(
    approval.getByRole("button", { name: "Always allow Cutroom edits" }),
  ).toHaveCount(0);
  await expect(
    approval.getByRole("button", { name: "Allow once" }),
  ).toBeVisible();
  await expect(approval.getByRole("button", { name: "Deny" })).toBeVisible();
});
