import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { agentTurn, playSession } from "./agent-turn";
import { expect, test } from "./fixtures";

for (const count of [30, 1_000]) {
  test(`${count} pending commands scroll while approval actions stay visible`, async ({
    page,
    request,
  }, info) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: `${count} pending commands` },
        })
      ).json(),
    );
    await writeFile(
      join(project.path, "index.html"),
      '<main data-composition-id="main" data-duration="40" data-fps="30"><div id="lower" class="clip" data-label="Lower third" data-start="1" data-duration="4" data-track-index="1">Words</div></main>',
    );
    const before = TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
    const turn = agentTurn(project.id);
    const waiting = {
      ...turn.session([], "waiting"),
      pendingRequest: {
        id: "large-approval",
        kind: "approval" as const,
        title: "Edit the timeline?",
        tool: "mcp__cutroom_studio__timeline_edit",
        canAllowCutroomEdits: true,
        input: {
          projectId: project.id,
          expectedRevision: before.revision,
          commands: Array.from({ length: count }, (_, i) => ({
            type: "setClip",
            clipId: "lower",
            opacity: (i % 10) / 10,
          })),
        },
      },
    };
    await playSession(page, [waiting]);
    let answer: unknown;
    await page.route(
      `**/api/cutroom/agents/sessions/${waiting.id}/responses`,
      async (route) => {
        answer = route.request().postDataJSON();
        await route.fulfill({
          json: { ...waiting, pendingRequest: undefined, status: "idle" },
        });
      },
    );
    await page.goto(`/#project/${project.id}`);
    const approval = page.getByRole("region", { name: "Permission request" });
    const list = approval.locator(".agent-request-commands");
    await expect(page.locator('[data-clip="lower"]')).toBeVisible();
    await expect(list.locator("li")).toHaveCount(count);
    await expect(list.locator("li").first()).toContainText("Lower third");
    await expect(approval.locator("pre")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`batch-${count}.png`) });
    for (const viewport of [
      { width: 1720, height: 1050 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      for (const name of ["Allow once", "Deny"]) {
        await expect
          .poll(async () => {
            const box = await approval
              .getByRole("button", { name, exact: true })
              .boundingBox();
            return (
              box !== null &&
              box.y >= 0 &&
              box.y + box.height <= viewport.height
            );
          })
          .toBe(true);
      }
      await list.hover();
      const top = await list.evaluate((element) => element.scrollTop);
      await page.mouse.wheel(0, 250);
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(top);
      await approval.getByRole("button", { name: "Details" }).click();
      await expect(approval.locator("pre")).toContainText('"opacity"');
      const box = await approval
        .getByRole("button", { name: "Allow once", exact: true })
        .boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      await approval.getByRole("button", { name: "Details" }).click();
    }
    const decision = count === 30 ? "allow" : "deny";
    await approval
      .getByRole("button", {
        name: count === 30 ? "Allow once" : "Deny",
        exact: true,
      })
      .click();
    await expect
      .poll(() => answer)
      .toMatchObject({ requestId: "large-approval", decision });
  });
}

test("an approval for another composition uses honest track and marker fallbacks", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Missing composition context" },
      })
    ).json(),
  );
  const turn = agentTurn(project.id);
  await playSession(page, [
    {
      ...turn.session([], "waiting"),
      pendingRequest: {
        id: "missing-context",
        kind: "approval",
        title: "Edit the timeline?",
        tool: "mcp__cutroom_studio__timeline_edit",
        input: {
          projectId: project.id,
          composition: "other.html",
          expectedRevision: "revision",
          commands: [
            { type: "removeTrack", index: 2 },
            { type: "setMarker", id: "hook", note: "new note" },
          ],
        },
      },
    },
  ]);
  await page.goto(`/#project/${project.id}`);
  const list = page.locator(".agent-request-commands li");
  await expect(list).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("missing-context.png") });
  await expect(list).toHaveText([
    "Remove empty track 2",
    'Set marker: note to "new note"',
  ]);
});
