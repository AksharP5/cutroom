import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { keymap } from "../src/client/keymap";

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

test("tool icons are named by their key, and the tooltip waits once then follows the pointer", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Icon tools" },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  const tools = page.getByRole("toolbar", { name: "Tools", exact: true });
  const tooltip = page.locator(".edit-tooltip");
  const name = (action: keyof typeof keymap) =>
    `${keymap[action].label} ${keymap[action].keys[0]}`;
  for (const action of [
    "cutroomDraw",
    "cutroomComment",
    "editTrim",
    "editBlade",
    "editPointer",
  ] as const) {
    const button = tools.getByRole("button", {
      name: name(action),
      exact: true,
    });
    await expect(button).toBeVisible();
    await page.keyboard.press(keymap[action].keys[0]);
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  const trim = tools.getByRole("button", {
    name: name("editTrim"),
    exact: true,
  });
  await trim.hover();
  await page.waitForTimeout(200);
  // A pointer passing over the row shows nothing.
  await expect(tooltip).toBeHidden();
  await expect(tooltip).toHaveText(
    keymap.editTrim.label + keymap.editTrim.keys[0],
  );
  await expect(tooltip).toBeVisible();
  // Once one is up, a neighbour's shows at once, well inside the first delay.
  await tools
    .getByRole("button", { name: name("editBlade"), exact: true })
    .hover();
  await expect(tooltip).toHaveText(
    keymap.editBlade.label + keymap.editBlade.keys[0],
    { timeout: 150 },
  );
  const [tip, blade] = await Promise.all([
    tooltip.boundingBox(),
    tools
      .getByRole("button", { name: name("editBlade"), exact: true })
      .boundingBox(),
  ]);
  expect(tip!.y).toBeGreaterThan(blade!.y + blade!.height);
  for (const [label, key] of [
    ["Draw", "D"],
    ["Comment", "C"],
  ]) {
    await tools
      .getByRole("button", { name: `${label} ${key}`, exact: true })
      .hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(label + key);
  }
  await page.mouse.move(600, 500);
  await expect(tooltip).toBeHidden();
  const snapping = tools.getByRole("button", { name: "Snapping", exact: true });
  await expect(snapping).toHaveAttribute("title", "Snapping (Alt+C)");
  await expect(snapping).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+c");
  await expect(snapping).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Alt+c");
  await expect(snapping).toHaveAttribute("aria-pressed", "true");
});
