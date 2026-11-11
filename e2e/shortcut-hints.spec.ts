import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { hint, keymap } from "../src/client/keymap";
import { embeddedEditor } from "./embedded";

test("the home screen shows the keymap's draw and comment keys", async ({
  page,
}) => {
  // The hints are on the first-run screen; other specs share this server's projects.
  await page.route("**/api/cutroom/projects", (route) =>
    route.fulfill({ json: { projects: [] } }),
  );
  await page.goto("/");
  await expect(page.locator(".welcome-instructions kbd")).toHaveText([
    keymap.cutroomDraw.keys[0],
    keymap.cutroomComment.keys[0],
    "$",
  ]);
  expect(
    await page
      .locator(".welcome-instructions kbd")
      .evaluateAll((keys) =>
        keys.every((key) => key.scrollWidth <= key.clientWidth),
      ),
  ).toBe(true);
});

for (const legacy of [false, true]) {
  test(`${legacy ? "embedded" : "new"} viewer tool hints match the keys that select them`, async ({
    page,
    request,
  }) => {
    if (legacy) await embeddedEditor(page);
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: "Keymap tools" },
        })
      ).json(),
    );
    await page.goto(`/#project/${project.id}`);
    for (const action of [
      "cutroomDraw",
      "cutroomComment",
      "editPointer",
    ] as const) {
      const button = page.getByTitle(hint(action), { exact: true });
      await expect(button).toBeVisible();
      await page.keyboard.press(keymap[action].keys[0]);
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(button.locator("kbd")).toHaveText(keymap[action].keys[0]);
    }
  });
}
