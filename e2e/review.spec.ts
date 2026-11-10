import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { AnnotationSchema, ProjectSchema } from "../src/shared/project";
import { ReviewItemSchema } from "../src/shared/review";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

test("review notes stay grouped by state until the owner accepts, answers, or restores them", async ({
  page,
  request,
}) => {
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
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Review queue" },
      })
    ).json(),
  );
  const base = `/api/cutroom/projects/${project.id}`;
  AnnotationSchema.parse(
    await (
      await request.post(`${base}/annotations`, {
        data: { kind: "comment", body: "Not sent yet", time: 1 },
      })
    ).json(),
  );
  const queued = async (body: string, time: number) =>
    ReviewItemSchema.parse(
      await (
        await request.post(`${base}/review`, { data: { body, time } })
      ).json(),
    ).id;
  const agent = (id: string, data: object) =>
    request.post(`${base}/review/${id}/agent`, { data });
  const done = await queued("Move the title up", 2);
  const withdrawn = await queued("Make the background red", 3);
  const blocked = await queued("Swap the logo", 4);
  await queued("Fade the music out", 5);
  await agent(withdrawn, {
    type: "withdraw",
    reason: "The owner asked to keep the original color.",
  });
  await agent(blocked, {
    type: "block",
    question: "Which logo file should I use?",
  });

  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const group = (name: string) =>
    page.getByRole("region", { name: `${name} notes`, exact: true });
  const waiting = page
    .locator(".status-bar")
    .getByRole("button", { name: /^To review \d+$/ });
  await expect(waiting).toHaveText("To review 1");
  await expect(group("New")).toContainText("Not sent yet");
  await expect(group("Queued")).toContainText("Move the title up");
  await expect(group("Queued")).toContainText("Fade the music out");
  await expect(group("To review")).toContainText(
    "Agent asks: Which logo file should I use?",
  );
  await expect(group("Withdrawn")).toContainText(
    "An outside agent withdrew it: The owner asked to keep the original color.",
  );

  // Agent progress arrives through the project watcher without a reload.
  await agent(done, {
    type: "complete",
    note: "Moved the title up 40px.",
  });
  await expect(group("To review")).toContainText("Moved the title up 40px.");
  await expect(waiting).toHaveText("To review 2");
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await waiting.click();
  await expect(group("To review")).toBeVisible();
  await page.screenshot({
    path: `${process.env.CUTROOM_E2E_DIR ?? "artifacts"}/review-queue.png`,
  });

  await expect(
    group("To review").getByRole("button", { name: "Reject", exact: true }),
  ).toBeVisible();
  await group("To review")
    .getByRole("button", { name: "Accept", exact: true })
    .click();
  await expect(group("Accepted")).toContainText("Move the title up");
  await expect(waiting).toHaveText("To review 1");
  await expect(group("To review")).not.toContainText("Move the title up");

  await group("To review").getByRole("button", { name: "Answer" }).click();
  await page.getByLabel("Answer the agent").fill("Use the white logo.");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(group("Queued")).toContainText("You added: Use the white logo.");
  await expect(waiting).toHaveCount(0);

  await group("Withdrawn")
    .getByRole("button", { name: "Restore to queue" })
    .click();
  await expect(group("Withdrawn")).toHaveCount(0);
  await expect(group("Queued")).toContainText("Make the background red");
});

test("an unreadable review file shows its error without the empty state", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Broken review file" },
      })
    ).json(),
  );
  await mkdir(join(project.path, ".cutroom"), { recursive: true });
  await writeFile(join(project.path, ".cutroom", "review.json"), "{oops");
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const panel = page.getByRole("region", { name: "Review notes" });
  await expect(panel.getByRole("alert")).toContainText("is unreadable");
  await expect(panel.getByText("Start with what you see.")).toHaveCount(0);
});

test("the owner can return a stuck claim to the queue", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Stuck claim" },
      })
    ).json(),
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const { id } = ReviewItemSchema.parse(
    await (
      await request.post(`${base}/review`, {
        data: { body: "Trim the last second", time: 4 },
      })
    ).json(),
  );
  await request.post(`${base}/review/${id}/agent`, {
    data: { type: "claim" },
  });
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const working = page.getByRole("region", {
    name: "In progress notes",
    exact: true,
  });
  await working.getByRole("button", { name: "Return to queue" }).click();
  await expect(working).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Queued notes", exact: true }),
  ).toContainText("Trim the last second");
});

test("typing a note after a stroke never drives the editor, and another note keeps the typed words", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Note focus" },
      })
    ).json(),
  );
  const range = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline.range;
  await page.goto(`/#project/${project.id}`);
  const preview = page.frameLocator("iframe[title='Composition preview']");
  await expect(preview.locator("#headline")).toHaveText("Note focus");
  const now = page.getByRole("button", { name: /^Current time/ });
  const stop = page.getByRole("button", { name: "Stop" });
  const note = page.getByLabel("What should change?");

  await page.getByRole("region", { name: "Viewer" }).click();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("i");
  await expect.poll(range).toEqual({ in: 30, out: null });

  await page.keyboard.press("Shift+n");
  const canvas = page.getByLabel("Draw on the composition");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The drawing canvas has no box.");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, {
    steps: 5,
  });
  await page.mouse.up();
  const untouched = async (text: string) => {
    await expect(note).toHaveValue(text);
    await expect(note).toBeFocused();
    await expect(stop).toHaveAttribute("aria-pressed", "true");
    await expect(now).toHaveText("00:00:01:00");
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(await range()).toEqual({ in: 30, out: null });
  };
  await page.keyboard.type("look in");
  await untouched("look in");

  // Pinning a comment while a note is half written keeps the words and the typing.
  await page.getByRole("button", { name: /^Comment/ }).click();
  await page.getByLabel("Pin a comment on the composition").click();
  await page.keyboard.type(" to play");
  await untouched("look in to play");
});

test("owner queue order and withdrawal survive reload, and Accept clears the changed clip underline", async ({
  page,
  request,
}) => {
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: false,
        skills: [],
        models: [],
        mcpServers: [],
      },
    }),
  );
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Agent change review" },
      })
    ).json(),
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const note = async (body: string) =>
    ReviewItemSchema.parse(
      await (
        await request.post(`${base}/review`, { data: { body, time: 0 } })
      ).json(),
    );
  const first = await note("First note");
  const second = await note("Second note");
  await request.post(`${base}/review/${first.id}/agent`, {
    data: { type: "claim" },
  });
  const before = TimelineViewSchema.parse(
    await (await request.get(`${base}/timeline`)).json(),
  );
  const edited = await request.post(`${base}/commands`, {
    headers: { "x-cutroom-agent": "external" },
    data: {
      expectedRevision: before.revision,
      commands: [
        { type: "setClip", clipId: "headline", label: "Agent opening" },
      ],
    },
  });
  expect(edited.ok()).toBe(true);
  await request.post(`${base}/review/${first.id}/agent`, {
    data: { type: "complete", note: "Renamed headline" },
  });
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const row = (body: string) =>
    page
      .locator(".review-row")
      .filter({ has: page.locator(".review-row-body", { hasText: body }) });
  await expect(page.locator('[data-agent-change="headline"]')).toBeVisible();
  await row("First note")
    .getByRole("button", { name: "Move note down" })
    .click();
  await expect(row("First note").locator(".note-pin")).toHaveText("2");
  await page.reload();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(row("Second note").locator(".note-pin")).toHaveText("1");
  await row("Second note")
    .getByRole("button", { name: "Withdraw", exact: true })
    .click();
  await expect(row("Second note")).toContainText(
    "You withdrew it: Withdrawn in Review.",
  );
  await page.reload();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(row("Second note")).toContainText(
    "You withdrew it: Withdrawn in Review.",
  );
  await row("First note")
    .getByRole("button", { name: "Accept", exact: true })
    .click();
  await expect(page.locator("[data-agent-change]")).toHaveCount(0);
});
