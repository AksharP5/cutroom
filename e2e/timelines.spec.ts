import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

test("a duplicated timeline edits apart from the original, opens as its equal, and reopens where it was left", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Interview", duration: 8 },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      /(<main[^>]*>)[\s\S]*<\/main>/,
      `$1
<div id="open" class="clip" data-start="0" data-duration="4" data-track-index="0">Open</div>
<div id="card" class="clip" data-start="4" data-duration="4" data-track-index="0">End card</div>
</main>`,
    ),
  );
  const read = async (composition: string) =>
    TimelineViewSchema.parse(
      await (
        await request.get(
          `/api/cutroom/projects/${project.id}/timeline?composition=${encodeURIComponent(composition)}`,
        )
      ).json(),
    ).timeline.clips.map((clip) => clip.id);
  const timelineReads: string[] = [];
  page.on("request", (sent) => {
    const url = new URL(sent.url());
    if (url.pathname.endsWith(`/projects/${project.id}/timeline`))
      timelineReads.push(url.searchParams.get("composition") ?? "index.html");
  });

  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  const media = page.getByRole("region", { name: "Media", exact: true });
  const path = page.getByRole("navigation", { name: "Composition" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(2);
  // A project with only its main timeline lists it, so it can be duplicated.
  await media.getByRole("button", { name: /^Compositions/ }).click();
  const list = media.getByRole("list", { name: "Compositions" });
  const row = (file: string) => list.locator(`[data-path="${file}"]`);
  await row("index.html").click({ button: "right" });
  await page.screenshot({ path: info.outputPath("compositions-menu.png") });
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(row("Interview copy.html")).toContainText("Interview copy");
  // The original stays open.
  await expect(row("index.html")).toHaveAttribute("aria-current", "true");

  // The copy opens in place of the original, named alone, and Esc does not leave it.
  await row("Interview copy.html").dblclick();
  await expect(row("Interview copy.html")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(path).toHaveText("Interview copy");
  await expect(path.getByRole("button")).toHaveCount(0);
  await timeline.locator('[data-clip="card"]').click();
  await page.keyboard.press("Delete");
  await expect(timeline.locator("[data-clip]")).toHaveCount(1);
  await expect.poll(() => read("Interview copy.html")).toEqual(["open"]);
  expect(await read("index.html")).toEqual(["open", "card"]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(row("Interview copy.html")).toHaveAttribute(
    "aria-current",
    "true",
  );

  // Switching back shows the original as it was.
  await row("index.html").dblclick();
  await expect(path).toHaveCount(0);
  await expect(timeline.locator("[data-clip]")).toHaveCount(2);

  // A reload reopens the last timeline shown, reading only that one.
  await row("Interview copy.html").dblclick();
  await expect(timeline.locator("[data-clip]")).toHaveCount(1);
  timelineReads.length = 0;
  await page.reload();
  await expect(path).toHaveText("Interview copy");
  await expect(timeline.locator("[data-clip]")).toHaveCount(1);
  expect(timelineReads).not.toContain("index.html");

  // Undo is project-wide. Taking back the duplicate while the copy is open returns to the original.
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => read("Interview copy.html"))
    .toEqual(["open", "card"]);
  await page.keyboard.press("Control+z");
  await expect(path).toHaveCount(0);
  await expect(timeline.locator("[data-clip]")).toHaveCount(2);
  await media.getByRole("button", { name: /^Compositions/ }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
});

test("Undo says which timeline it changed when that is not the open one, even for a marker", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Markers", duration: 4 },
      })
    ).json(),
  );
  const duplicated = await request.post(
    `/api/cutroom/projects/${project.id}/timelines/duplicate`,
    { data: { name: "Cut" } },
  );
  expect(duplicated.ok()).toBe(true);
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  const media = page.getByRole("region", { name: "Media", exact: true });
  await expect(timeline.locator("[data-clip]").first()).toBeVisible();
  // A marker on index.html is saved in cutroom.json alone.
  await page.keyboard.press("m");
  await expect(timeline.locator(".tl-marker")).toHaveCount(1);
  await media.getByRole("button", { name: /^Compositions/ }).click();
  await media.locator('[data-path="Cut.html"]').dblclick();
  await expect(
    page.getByRole("navigation", { name: "Composition" }),
  ).toHaveText("Cut");
  await page.keyboard.press("Control+z");
  await expect(page.getByText(/in index\.html\.$/)).toBeVisible();
});
