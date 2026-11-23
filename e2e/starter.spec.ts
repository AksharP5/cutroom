import { expect, test } from "./fixtures";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

test("a new project opens on an empty V1 and A1, and its first clip sets the length", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.keyboard.type("First cut");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#project\//);
  const id = /#project\/([\w-]+)/.exec(page.url())![1];
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator(".tl-head")).toHaveText([/V1/, /A1/]);
  await expect(timeline.locator("[data-clip]")).toHaveCount(0);
  const hint = page.locator(".edit-empty");
  await expect(hint).toHaveText("Drop media in, or ask your agent to start.");

  const route = `/api/cutroom/projects/${id}`;
  const view = TimelineViewSchema.parse(
    await (await request.get(`${route}/timeline`)).json(),
  );
  const added = await request.post(`${route}/commands`, {
    data: {
      expectedRevision: view.revision,
      commands: [
        {
          type: "insert",
          track: 0,
          at: 0,
          clip: { kind: "title", text: "Hello", duration: 60 },
        },
      ],
    },
  });
  expect(added.ok()).toBe(true);
  await expect(timeline.locator("[data-clip]")).toHaveCount(1);
  await expect(hint).toHaveCount(0);
  expect(
    TimelineViewSchema.parse(
      await (await request.get(`${route}/timeline`)).json(),
    ).timeline.duration,
  ).toBe(60);
});
