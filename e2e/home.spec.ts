import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema, SourceSchema } from "../src/shared/project";

const create = async (request: APIRequestContext, data: object) =>
  ProjectSchema.parse(
    await (await request.post("/api/cutroom/projects", { data })).json(),
  );
const tile = (page: Page, name: string) =>
  page.locator(".home-project").filter({
    has: page.locator(".home-name").getByText(name, { exact: true }),
  });

test("home is the first-run hero until a project exists, then the projects", async ({
  page,
  request,
}) => {
  // Other specs share this server's projects; first run is the empty list.
  await page.route("**/api/cutroom/projects", (route) =>
    route.fulfill({ json: { projects: [] } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Make the next cut." }),
  ).toBeVisible();
  await expect(page.locator(".home-project")).toHaveCount(0);

  const project = await create(request, { name: `First cut ${Date.now()}` });
  await page.unroute("**/api/cutroom/projects");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(tile(page, project.name)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Make the next cut." }),
  ).toHaveCount(0);
  // Creating and opening a folder stay one click away.
  await expect(
    page.getByRole("button", { name: "Open folder", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "New project", exact: true }),
  ).toBeVisible();
});

test("projects are ordered by last edit, and an edit elsewhere reorders an open home", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const older = await create(request, { name: `Older ${stamp}` });
  const newer = await create(request, { name: `Newer ${stamp}` });
  await page.goto("/");
  const names = page.locator(".home-name");
  await expect(names.nth(0)).toHaveText(newer.name);
  await expect(names.nth(1)).toHaveText(older.name);

  const path = `/api/cutroom/projects/${older.id}/source`;
  const source = SourceSchema.parse(await (await request.get(path)).json());
  expect(
    (
      await request.put(path, {
        data: {
          path: "index.html",
          content: source.content.replace("Drop media in", "Drop footage in"),
          expectedVersion: source.version,
        },
      })
    ).ok(),
  ).toBe(true);
  // Coming back to the window is when home catches up.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(names.nth(0)).toHaveText(older.name);
  await expect(names.nth(1)).toHaveText(newer.name);
  await expect(tile(page, older.name).locator("time")).toHaveText("Just now");
});

test("the keyboard walks the grid and opens a project", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const projects = [];
  for (const name of ["Third", "Second", "First"])
    projects.push(await create(request, { name: `${name} ${stamp}` }));
  const [third, second, first] = projects;
  // Two columns, so the third tile sits under the first.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/");
  await expect(tile(page, first!.name)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tile(page, second!.name)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await expect(tile(page, third!.name)).toBeFocused();
  // Only the tile last focused is a tab stop.
  await expect(page.locator('.home-project[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#project/${third!.id}`));
  await expect(page.locator(".project-switcher")).toHaveText(third!.name);
});

test("a poster is a placeholder until its frame has rendered", async ({
  page,
  request,
}) => {
  const project = await create(request, {
    name: `Portrait ${Date.now()}`,
    width: 1080,
    height: 1920,
    duration: 94,
  });
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/thumbnail/**", async (route) => {
    await held;
    await route.fallback();
  });
  await page.goto("/");
  const portrait = tile(page, project.name);
  // Length and shape do not wait for the picture.
  await expect(portrait.locator(".home-meta .mono")).toHaveText([
    "1:34",
    "9:16",
  ]);
  await expect(portrait).toHaveAttribute("data-poster", "pending");
  await expect(portrait.locator("img")).toHaveCSS("opacity", "0");
  release();
  await expect(portrait).toHaveAttribute("data-poster", "ready");
  await expect(portrait.locator("img")).toHaveCSS("opacity", "1");
  expect(
    await portrait
      .locator("img")
      .evaluate((image: HTMLImageElement) => [
        image.naturalWidth,
        image.naturalHeight,
      ]),
  ).toEqual([1080, 1920]);
  // The frame keeps the project's shape inside the 16:9 well.
  const [well, frame] = await Promise.all([
    portrait.locator(".home-well").boundingBox(),
    portrait.locator(".home-frame").boundingBox(),
  ]);
  expect(frame!.height).toBeCloseTo(well!.height, 0);
  expect(frame!.width / frame!.height).toBeCloseTo(9 / 16, 2);
});

test("home dates direct composition and document edits", async ({
  page,
  request,
}, info) => {
  const project = await create(request, { name: "File date evidence" });
  const html = join(project.path, "index.html");
  const document = join(project.path, "cutroom.json");
  const old = new Date(Date.now() - 3 * 86400000);
  await utimes(html, old, old);
  await utimes(document, old, old);
  await page.goto("/");
  const date = tile(page, project.name).locator("time");
  await page.screenshot({ path: info.outputPath("file-date.png") });
  await expect(date).toHaveText("3 d ago");
  await utimes(document, new Date(), new Date());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(date).toHaveText("Just now");
});
