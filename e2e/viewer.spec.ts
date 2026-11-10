import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { ProjectDocumentSchema, ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

test("the new viewer refuses composition API calls and parent access while remaining playable", async ({
  page,
  request,
}, testInfo) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Untrusted preview" },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  const source = await readFile(index, "utf8");
  const script = `<script>
    (async () => {
      const results = {};
      const post = body => ({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      const attempts = {
        annotation: () => fetch("/api/cutroom/projects/${project.id}/annotations", post({kind:"comment",body:"untrusted",time:0})),
        approval: () => fetch("/api/cutroom/agents/sessions/forbidden/responses", post({requestId:"approval",decision:"allow"})),
        projects: () => fetch("/api/cutroom/projects"),
        parent: () => parent.document.body,
        external: () => fetch("https://outside.invalid/collect")
      };
      for (const [name, attempt] of Object.entries(attempts)) {
        try { await attempt(); results[name] = "allowed"; } catch { results[name] = "blocked"; }
      }
      document.querySelector("main").setAttribute("data-attacks", JSON.stringify(results));
    })();
  </script>`;
  await writeFile(index, source.replace("</body>", `${script}</body>`));
  await page.addInitScript(() =>
    localStorage.setItem("cutroom.newEditor", "true"),
  );
  await page.goto(`/#project/${project.id}`);
  const live = page.frameLocator("iframe[data-live]");
  await expect(live.locator("main")).toHaveAttribute(
    "data-attacks",
    JSON.stringify({
      annotation: "blocked",
      approval: "blocked",
      projects: "blocked",
      parent: "blocked",
      external: "blocked",
    }),
  );
  await expect(page.locator("iframe[data-live]")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  const document = ProjectDocumentSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/document`)
    ).json(),
  );
  expect(document.annotations).toEqual([]);
  await page.getByRole("region", { name: "Viewer" }).click();
  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: /^Current time/ }),
  ).not.toHaveText("00:00:00:00");
  await page.keyboard.press("k");
  await expect(page.locator(".status-error")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("isolated-viewer.png") });
});

test("the new editor plays, steps, and marks in and out as undoable timeline edits", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Own viewer" },
      })
    ).json(),
  );
  const range = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline.range;
  await page.addInitScript(() =>
    localStorage.setItem("cutroom.newEditor", "true"),
  );
  await page.goto(`/#project/${project.id}`);

  const preview = page.frameLocator("iframe[title='Composition preview']");
  await expect(preview.locator("#headline")).toHaveText("Own viewer");
  const now = page.getByRole("button", { name: /^Current time/ });
  const play = page.getByRole("button", { name: "Play forward" });
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(now).toHaveText("00:00:00:00");
  await expect(
    page.getByRole("region", { name: "Viewer" }).getByText("00:00:12:00"),
  ).toBeVisible();

  // Typing never drives the transport.
  const composer = page.getByPlaceholder("Describe the next edit");
  await composer.fill("");
  await composer.press("l");
  await composer.press("Space");
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(composer).toHaveValue("l ");
  await composer.fill("");
  await page.getByRole("region", { name: "Viewer" }).click();

  await page.keyboard.press("l");
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await expect(now).not.toHaveText("00:00:00:00");
  await page.keyboard.press("l");
  await expect(page.getByLabel("Shuttle speed")).toHaveText("2x");
  await page.keyboard.press("k");
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Shuttle speed")).toHaveText("");

  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(now).toHaveText("00:00:00:02");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(now).toHaveText("00:00:01:02");

  await page.keyboard.press("i");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("o");
  await expect(
    page.getByText(/In\s*00:00:01:02\s*Out\s*00:00:02:02/),
  ).toBeVisible();
  // The marks show before the server answers, so its copy is read until it catches up.
  await expect.poll(range).toEqual({ in: 32, out: 63 });

  await page.keyboard.press("Shift+i");
  await expect(now).toHaveText("00:00:01:02");

  await page.keyboard.press("Control+z");
  await expect.poll(range).toEqual({ in: 32, out: null });
  await expect(page.getByText("Out", { exact: true })).toHaveCount(0);

  // A typed time seeks; digits fill from the right.
  await now.click();
  await page.keyboard.type("504");
  await page.keyboard.press("Enter");
  await expect(now).toHaveText("00:00:05:04");

  // Marks and undo pressed faster than the server answers apply in order.
  await page.keyboard.press("Alt+x");
  await expect.poll(range).toEqual({ in: null, out: null });
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("i");
  await page.keyboard.press("o");
  await page.keyboard.press("Backquote");
  await expect.poll(range).toEqual({ in: 30, out: null });
  await expect(page.getByText(/In\s*00:00:01:00/)).toBeVisible();
  await expect(page.locator(".status-error")).toHaveCount(0);
});

test("a composition that cannot play keeps the last picture and says why", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Held picture" },
      })
    ).json(),
  );
  await page.addInitScript(() =>
    localStorage.setItem("cutroom.newEditor", "true"),
  );
  await page.goto(`/#project/${project.id}`);
  const live = page.frameLocator("iframe[data-live]");
  await expect(live.locator("#headline")).toHaveText("Held picture");

  const index = join(project.path, "index.html");
  const good = await readFile(index, "utf8");
  await writeFile(index, "<!doctype html><main>No composition</main>\n");
  await expect(page.locator(".status-error")).toContainText(
    "data-composition-id",
  );
  await expect(page.locator("iframe[title='Composition preview']")).toHaveCount(
    1,
  );
  await expect(live.locator("#headline")).toHaveText("Held picture");

  // Fixing the file brings the picture back and clears the report.
  await writeFile(index, good.replace("A new composition.", "Back again."));
  await expect(live.locator("#caption")).toHaveText("Back again.");
  await expect(page.locator(".status-error")).toHaveCount(0);
});

test("a timeline the engine refuses stays reported after the picture reloads", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Refused timeline" },
      })
    ).json(),
  );
  await page.addInitScript(() =>
    localStorage.setItem("cutroom.newEditor", "true"),
  );
  await page.goto(`/#project/${project.id}`);
  const live = page.frameLocator("iframe[data-live]");
  await expect(live.locator("#headline")).toHaveText("Refused timeline");

  // The runtime plays a clip without a length; the engine cannot place it.
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      "</main>",
      '<div id="extra" class="clip" data-start="1" data-track-index="3">Extra</div></main>',
    ),
  );
  // The reloaded picture arrives after the engine's refusal and must not hide it.
  await expect(live.locator("#extra")).toHaveCount(1);
  const status = page.locator(".status-error");
  await expect(status).toContainText("Clip extra has no data-duration");
  await page.waitForTimeout(500);
  await expect(status).toContainText("Clip extra has no data-duration");
});
