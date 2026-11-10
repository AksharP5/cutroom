import { expect, test } from "@playwright/test";
import { AnnotationSchema, ProjectSchema } from "../src/shared/project";
import { ReviewItemSchema } from "../src/shared/review";

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
  await expect(group("New")).toContainText("Not sent yet");
  await expect(group("Queued")).toContainText("Move the title up");
  await expect(group("Queued")).toContainText("Fade the music out");
  await expect(group("Needs your answer")).toContainText(
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
  await expect(group("Done")).toContainText("Moved the title up 40px.");
  await page.screenshot({ path: "artifacts/review-queue.png" });

  await expect(
    group("Done").getByRole("button", { name: "Send back with changes" }),
  ).toBeVisible();
  await group("Done").getByRole("button", { name: "Accept" }).click();
  await expect(group("Done")).toHaveCount(0);
  await page.getByText("Accepted notes").click();
  await expect(page.getByText("Move the title up")).toBeVisible();

  await group("Needs your answer")
    .getByRole("button", { name: "Answer" })
    .click();
  await page.getByLabel("Answer the agent").fill("Use the white logo.");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(group("Queued")).toContainText("You added: Use the white logo.");

  await group("Withdrawn")
    .getByRole("button", { name: "Restore to queue" })
    .click();
  await expect(group("Withdrawn")).toHaveCount(0);
  await expect(group("Queued")).toContainText("Make the background red");
});
