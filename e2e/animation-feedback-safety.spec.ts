import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { reviewTweenScripts } from "./fixtures/animation-feedback/review-cases";
import { expect, test } from "./fixtures";

type Probe = {
  globalTime(time: number): number;
  getChildren(
    nested: boolean,
    tweens: boolean,
    timelines: boolean,
  ): { targets(): HTMLElement[]; globalTime(time: number): number }[];
};
for (const [name, script] of Object.entries(reviewTweenScripts))
  test(`R1 ${name}: Inspector move preserves authored script and every runtime tween, with a toast`, async ({
    page,
    request,
  }, info) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: `Review ${name}` },
        })
      ).json(),
    );
    const file = join(project.path, "index.html");
    const html = `<!doctype html><html><head><style>html,body{margin:0;background:#111;color:white;font:100px system-ui}.clip{position:absolute;left:150px}</style><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="48"><div id="cta" class="clip" data-start="36" data-duration="8" data-track-index="0" style="top:200px">Moved clip</div><div id="shot-b" class="clip" data-start="36" data-duration="8" data-track-index="1" style="top:600px">Unmoved clip</div></main><script>${script}</script></body></html>`;
    await writeFile(file, html);
    await copyFile(
      join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
      join(project.path, "gsap.min.js"),
    );
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator('[data-clip="cta"]')).toBeVisible();
    await expect(page.locator("iframe[data-live]")).toHaveCount(1);
    const timing = () =>
      page
        .frameLocator("iframe[data-live]")
        .locator("body")
        .evaluate(() => {
          // The fixture registers the real GSAP timeline, not a simulated timing model.
          const timelines = window as typeof window & {
            __timelines: Record<string, Probe>;
          };
          const root = timelines.__timelines.main;
          return root.getChildren(true, true, false).flatMap((tween) => {
            const id = tween.targets()[0]?.id;
            return id === "cta" || id === "shot-b"
              ? [{ id, at: tween.globalTime(0) - root.globalTime(0) }]
              : [];
          });
        });
    const before = await timing();
    if (name === "relative") {
      await page.getByRole("button", { name: /^Current time/ }).click();
      await page.getByLabel("Go to time").pressSequentially("3615");
      await page.keyboard.press("Enter");
      await expect(
        page.frameLocator("iframe[data-live]").locator("#shot-b"),
      ).toHaveCSS("opacity", "0.5");
      await page.screenshot({ path: info.outputPath("before.png") });
    }
    await page.locator('[data-clip="cta"]').click();
    const start = page
      .getByRole("complementary", { name: "Inspector" })
      .getByRole("textbox", { name: "Start", exact: true });
    await start.fill("37s");
    await start.press("Enter");
    await expect(
      page.frameLocator("iframe[data-live]").locator("#cta"),
    ).toHaveAttribute("data-start", "37");
    const view = TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
    expect(view.timeline.clips.map(({ id, start }) => ({ id, start }))).toEqual(
      expect.arrayContaining([
        { id: "cta", start: 1110 },
        { id: "shot-b", start: 1080 },
      ]),
    );
    const written = await readFile(file, "utf8");
    expect(
      written.slice(
        written.lastIndexOf("<script>") + 8,
        written.lastIndexOf("</script>"),
      ),
    ).toBe(script);
    const after = await timing();
    expect(after).toEqual(before);
    const toast = page
      .getByRole("status")
      .filter({ hasText: /cta's animation stayed/ });
    await expect(toast).toBeVisible();
    const toastMessage = await toast.innerText();
    await expect(
      toast.getByRole("button", { name: "Ask agent", exact: true }),
    ).toBeVisible();
    if (name === "relative") {
      await expect(
        page.frameLocator("iframe[data-live]").locator("#shot-b"),
      ).toHaveCSS("opacity", "0.5");
      await page.screenshot({
        path: info.outputPath("warning.png"),
      });
    }
    console.log(
      JSON.stringify({
        name,
        before,
        after,
        scriptUnchanged: true,
        toast: toastMessage,
      }),
    );
    await info.attach("safety-result.json", {
      body: JSON.stringify(
        { name, before, after, scriptUnchanged: true },
        null,
        2,
      ),
      contentType: "application/json",
    });
  });
