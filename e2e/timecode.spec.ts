import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

test("timecode waits for the initial timeline before accepting a seek", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Timecode startup",
          width: 800,
          height: 450,
          duration: 5,
        },
      })
    ).json(),
  );
  await copyFile(
    join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
    join(project.path, "gsap.min.js"),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><script src="gsap.min.js"></script></head><body style="margin:0;background:#111;color:white"><main data-composition-id="main" data-width="800" data-height="450" data-duration="5"><div id="title" class="clip" data-start="0" data-duration="5">Title</div></main><script>window.__timelines={main:gsap.timeline({paused:true}).to("#title",{x:450,duration:1,ease:"none"},0)};</script></body></html>`,
  );
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    `**/api/cutroom/projects/${project.id}/timeline`,
    async (route) => {
      await held;
      await route.continue();
    },
  );
  try {
    await page.goto(`/#project/${project.id}`);
    const clock = page.getByRole("button", {
      name: "Current time. Click to type a time.",
      exact: true,
    });
    await expect(clock).toBeDisabled();
    await page.screenshot({ path: info.outputPath("loading.png") });
    release();
    await expect(clock).toBeEnabled();
    await seekFrame(page, 15);
    await expect(clock).toHaveText("00:00:00:15");
    await expect
      .poll(() =>
        page
          .frameLocator("iframe[data-live]")
          .locator("#title")
          .evaluate(
            (element) => new DOMMatrix(getComputedStyle(element).transform).m41,
          ),
      )
      .toBeCloseTo(225, 0);
    await page.screenshot({ path: info.outputPath("frame-15.png") });
  } finally {
    release();
  }
});
