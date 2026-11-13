import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectSchema } from "../src/shared/project";
import { reviewR2Cases } from "./fixtures/animation-feedback/review-r2";
import { expect, test } from "./fixtures";

type Tween = { targets(): unknown[]; startTime(): number };
type Root = {
  globalTime(time: number): number;
  getChildren(nested: boolean, tweens: boolean, timelines: boolean): Tween[];
};
for (const [name, example] of Object.entries(reviewR2Cases))
  test(`R2 ${name}: Inspector move warns and preserves unrelated animation`, async ({
    page,
    request,
  }, info) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: `R2 ${name}` },
        })
      ).json(),
    );
    const duplicate =
      "duplicate" in example ? '<span id="cta">Duplicate target</span>' : "";
    const extra = "extra" in example ? example.extra : "";
    const html = `<!doctype html><html><head><style>html,body{margin:0;background:#111;color:white;font:100px system-ui}.clip{position:absolute;left:150px;opacity:0}</style><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="48"><div id="cta" class="clip cta" data-start="36" data-duration="8" data-track-index="0" style="top:200px">Moved clip</div><div id="shot-b" class="clip" data-start="36" data-duration="8" data-track-index="1" style="top:600px">Unmoved clip${duplicate}</div></main><script>${example.script}</script>${extra}</body></html>`;
    const file = join(project.path, "index.html");
    await writeFile(file, html);
    await copyFile(
      join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
      join(project.path, "gsap.min.js"),
    );
    if ("external" in example)
      await writeFile(join(project.path, "follow.js"), example.external);
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator('[data-clip="cta"]')).toBeVisible();
    await expect(page.locator("iframe[data-live]")).toHaveCount(1);
    const timings = () =>
      page
        .frameLocator("iframe[data-live]")
        .locator("body")
        .evaluate(() => {
          const root = (
            window as typeof window & { __timelines: Record<string, Root> }
          ).__timelines.main;
          return root.getChildren(true, true, false).flatMap((tween) =>
            tween
              .targets()
              .filter(
                (target): target is HTMLElement =>
                  target instanceof HTMLElement &&
                  ["cta", "shot-b"].includes(target.id),
              )
              .map((target) => ({
                id: target.id,
                owner: target.closest("[data-start]")?.id,
                at: tween.startTime(),
              })),
          );
        });
    const before = await timings();
    expect(before.every((tween) => Number.isFinite(tween.at))).toBe(true);
    if (name === "external") {
      await page.getByRole("button", { name: /^Current time/ }).click();
      await page.getByLabel("Go to time").pressSequentially("3615");
      await page.keyboard.press("Enter");
      await page.screenshot({ path: info.outputPath("before.png") });
    }
    await page.locator('[data-clip="cta"]').click();
    const start = page
      .getByRole("complementary", { name: "Inspector" })
      .getByRole("textbox", { name: "Start", exact: true });
    await start.fill("37s");
    await start.press("Enter");
    await expect(
      page.frameLocator("iframe[data-live]").locator('[id="cta"][data-start]'),
    ).toHaveAttribute("data-start", "37");
    const output = await readFile(file, "utf8");
    const scripts = (text: string) => text.match(/<script>[^]*?<\/script>/g);
    expect(scripts(output)).toEqual(scripts(html));
    const after = await timings();
    if (name === "aliasedDefaults" || name === "computedMethod") {
      expect(before.map((tween) => tween.at)).toEqual([36]);
      expect(after.map((tween) => tween.at)).toEqual([37]);
    } else expect(after).toEqual(before);
    const toast = page
      .getByRole("status")
      .filter({ hasText: /cta's animation stayed/ });
    await expect(toast).toBeVisible();
    const toastMessage = await toast.innerText();
    await expect(
      toast.getByRole("button", { name: "Ask agent", exact: true }),
    ).toBeVisible();
    if (name === "external") {
      await expect(
        page.frameLocator("iframe[data-live]").locator("#shot-b"),
      ).toHaveCSS("opacity", "0.5");
      await page.screenshot({ path: info.outputPath("warning.png") });
    }
    console.log(
      JSON.stringify({
        r2: name,
        before,
        after,
        scriptUnchanged: true,
        toast: toastMessage,
      }),
    );
  });

test("R2 Map.set does not claim that a clip has animation", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "R2 Map silence" },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    '<html><body><main data-composition-id="main" data-width="1920" data-height="1080" data-fps="30" data-duration="48"><div id="cta" class="clip" data-start="36" data-duration="4" data-track-index="0">Title</div></main><script>new Map().set("#cta",{opacity:1});</script></body></html>',
  );
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="cta"]').click();
  const start = page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("textbox", { name: "Start", exact: true });
  await start.fill("37s");
  await start.press("Enter");
  await expect
    .poll(() => readFile(join(project.path, "index.html"), "utf8"))
    .toContain('data-start="37"');
  await expect(
    page.frameLocator("iframe[data-live]").locator('[id="cta"][data-start]'),
  ).toHaveAttribute("data-start", "37");
  await expect(
    page.getByRole("status").filter({ hasText: /animation stayed/ }),
  ).toHaveCount(0);
});
