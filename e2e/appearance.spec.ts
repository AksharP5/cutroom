import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";

const viewports = [
  { width: 956, height: 1050 },
  { width: 1440, height: 900 },
  { width: 1720, height: 1050 },
];

async function openWorkspace(page: Page, request: APIRequestContext) {
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
        data: { name: "Room to create" },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(
    page.frameLocator("hyperframes-player iframe").last().locator("#headline"),
  ).toHaveText(project.name);
  await page.evaluate(() => document.fonts.ready);
}

async function expectOnScreen(locator: Locator, page: Page) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  if (!bounds || !viewport) throw new Error("Visible control has no bounds.");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectReadable(locator: Locator) {
  const contrast = await locator.evaluate((element) => {
    const channels = (color: string) => {
      const values = color.match(/[\d.]+/g)?.map(Number);
      if (!values || values.length < 3)
        throw new Error(`Cannot read computed color ${color}.`);
      return values;
    };
    const luminance = (color: string) =>
      channels(color)
        .slice(0, 3)
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    let background: Element | null = element;
    while (background) {
      const color = getComputedStyle(background).backgroundColor;
      if ((channels(color)[3] ?? 1) === 1) {
        const foreground = luminance(getComputedStyle(element).color);
        const behind = luminance(color);
        return (
          (Math.max(foreground, behind) + 0.05) /
          (Math.min(foreground, behind) + 0.05)
        );
      }
      background = background.parentElement;
    }
    throw new Error("The control has no opaque background.");
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}

for (const viewport of viewports) {
  test(`workspace keeps the preview and controls usable at ${viewport.width}×${viewport.height}`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await openWorkspace(page, request);

    const preview = page.locator("hyperframes-player iframe").last();
    await expectOnScreen(preview, page);
    const bounds = await preview.boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(320);
    expect(bounds?.height).toBeGreaterThanOrEqual(180);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);

    for (const control of [
      page.getByRole("button", { name: "Agent", exact: true }),
      page.getByRole("button", { name: "Review", exact: true }),
      page.getByRole("button", { name: "Script", exact: true }),
      page.getByRole("button", { name: "Select (V)", exact: true }),
      page.getByRole("button", { name: "Draw (D)", exact: true }),
      page.getByRole("button", { name: "Comment (C)", exact: true }),
      page.getByRole("button", { name: "Toggle project files", exact: true }),
      page.getByRole("button", { name: "Toggle inspector", exact: true }),
      page.getByRole("button", { name: "Export", exact: true }),
      page.getByRole("button", { name: "Import media", exact: true }),
      page.getByRole("button", { name: "Play", exact: true }),
      page.getByLabel("Agent provider", { exact: true }),
      page.getByLabel("Message your agent", { exact: true }),
    ]) {
      await expectOnScreen(control, page);
    }
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expectOnScreen(
      page.getByRole("region", { name: "Review notes" }),
      page,
    );
    await page.getByRole("button", { name: "Script", exact: true }).click();
    await expectOnScreen(
      page.getByRole("region", { name: "Script editor" }),
      page,
    );
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    const ongoingAnimations = () =>
      page.evaluate(() =>
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.playState === "running" &&
              animation.effect?.getTiming().iterations === Infinity,
          )
          .map((animation) => {
            const effect = animation.effect;
            return {
              id: animation.id,
              target:
                effect instanceof KeyframeEffect &&
                effect.target instanceof Element
                  ? effect.target.outerHTML.slice(0, 250)
                  : "unknown",
            };
          }),
      );
    await expect.poll(ongoingAnimations).toEqual([]);
    const composer = page.getByLabel("Message your agent", { exact: true });
    await composer.fill("A clear message on the dark workspace.");
    await expectReadable(composer);
    await expectReadable(
      page.getByRole("button", { name: "Play", exact: true }),
    );
    await expectReadable(
      page.getByRole("button", { name: "Playback speed", exact: true }),
    );
    await expect(page.getByRole("button", { name: /theme/i })).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`workspace-${viewport.width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Workspace settings",
      exact: true,
    });
    await expectOnScreen(dialog, page);
    const dialogBounds = await dialog.boundingBox();
    if (!dialogBounds) throw new Error("The settings dialog has no bounds.");
    expect(
      Math.abs(dialogBounds.x + dialogBounds.width / 2 - viewport.width / 2),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(dialogBounds.y + dialogBounds.height / 2 - viewport.height / 2),
    ).toBeLessThanOrEqual(2);
    await page.screenshot({
      path: testInfo.outputPath(`settings-${viewport.width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
  });
}

test("review and agent drafts survive workspace tabs, panels, and resizing", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page, request);
  const agentDraft = "Keep this unsent editing request.";
  const reviewDraft = "Keep this review draft while I inspect the workspace.";
  const composer = page.getByLabel("Message your agent", { exact: true });
  await composer.fill(agentDraft);
  await page.getByRole("button", { name: "Comment (C)", exact: true }).click();
  await page
    .getByLabel("Pin a comment on the composition")
    .click({ position: { x: 100, y: 80 } });
  const note = page.getByLabel("What should change?", { exact: true });
  await note.fill(reviewDraft);
  await page.getByRole("button", { name: "Script", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(composer).toHaveValue(agentDraft);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(note).toHaveValue(reviewDraft);

  await page.getByRole("button", { name: "Focus editor", exact: true }).click();
  await page.setViewportSize({ width: 956, height: 1050 });
  await page.getByRole("button", { name: "Focus editor", exact: true }).click();
  await expect(note).toHaveValue(reviewDraft);
  await expectOnScreen(note, page);
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(composer).toHaveValue(agentDraft);
  await expectOnScreen(composer, page);
  await page.getByRole("button", { name: "Focus editor", exact: true }).click();
  await page.setViewportSize({ width: 1720, height: 1050 });
  await page.getByRole("button", { name: "Focus editor", exact: true }).click();
  await page
    .getByRole("button", { name: "Toggle project files", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Toggle project files", exact: true })
    .click();
  await expect(composer).toHaveValue(agentDraft);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(note).toHaveValue(reviewDraft);
});
