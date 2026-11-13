import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import {
  childComposition,
  r3Composition,
} from "./fixtures/animation-feedback/review-r3";
import { test, expect } from "./fixtures";
type Tween = { targets(): unknown[]; startTime(): number };
type Root = {
  getChildren(nested: boolean, tweens: boolean, timelines: boolean): Tween[];
};
for (const kind of ["nested", "quirks", "precision"] as const)
  test(`R3 ${kind}: move warns and preserves rendered animation`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(120000);
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: `R3 ${kind}` },
        })
      ).json(),
    );
    const original = r3Composition(kind),
      file = join(project.path, "index.html");
    await writeFile(file, original);
    await copyFile(
      join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
      join(project.path, "gsap.min.js"),
    );
    if (kind === "nested")
      await writeFile(join(project.path, "child.html"), childComposition);
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator("iframe[data-live]")).toHaveCount(1);
    const body = page.frameLocator("iframe[data-live]").locator("body");
    const sample = () =>
      body.evaluate(() => {
        const root = (
          window as typeof window & { __timelines: Record<string, Root> }
        ).__timelines.main;
        return {
          mode: document.compatMode,
          tweens: root.getChildren(true, true, false).flatMap((tween) =>
            tween
              .targets()
              .filter(
                (target): target is HTMLElement =>
                  target instanceof HTMLElement &&
                  ["cta", "CTA"].includes(target.id),
              )
              .map((target) => ({
                id: target.id,
                host: target
                  .closest("[data-composition-id]")
                  ?.getAttribute("data-composition-id"),
                at: tween.startTime(),
              })),
          ),
        };
      });
    if (kind !== "precision") {
      await page.getByRole("button", { name: /^Current time/ }).click();
      await page.getByLabel("Go to time").pressSequentially("0500");
      await page.keyboard.press("Enter");
    }
    const before = await sample();
    expect(before.mode).toBe(kind === "quirks" ? "BackCompat" : "CSS1Compat");
    expect(before.tweens).toHaveLength(kind === "precision" ? 1 : 2);
    await page.screenshot({ path: info.outputPath("before.png") });
    await page.locator('[data-clip="cta"]').click();
    const start = page
      .getByRole("complementary", { name: "Inspector" })
      .getByRole("textbox", { name: "Start", exact: true });
    await start.fill(kind === "precision" ? "4.033333s" : "6s");
    await start.press("Enter");
    await expect
      .poll(() =>
        body.evaluate(() =>
          Number(
            [...document.querySelectorAll("[data-start]")]
              .find((e) => e.id === "cta")
              ?.getAttribute("data-start"),
          ),
        ),
      )
      .toBeCloseTo(kind === "precision" ? 121 / 30 : 6, 6);
    const written = await readFile(file, "utf8");
    expect(written.match(/<script>[^]*?<\/script>/g)).toEqual(
      original.match(/<script>[^]*?<\/script>/g),
    );
    const after = await sample();
    expect(after).toEqual(before);
    const toast = page
      .getByRole("status")
      .filter({ hasText: /cta's animation stayed/ });
    await expect(toast).toBeVisible();
    const toastMessage = await toast.innerText();
    await expect(
      toast.getByRole("button", { name: "Ask agent", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("warning.png") });
    if (kind !== "precision") {
      const target =
        kind === "nested"
          ? body.locator('[data-composition-id="child"] [id="cta"]')
          : body.locator('[id="CTA"]');
      await expect(target).toHaveCSS("opacity", "0.5");
    }
    if (kind === "nested") {
      const directory = info.outputPath("export");
      await mkdir(directory, { recursive: true });
      const response = await request.post(
        `/api/projects/${project.id}/export`,
        {
          data: {
            range: { start: 150, end: 153 },
            quality: "draft",
            directory,
            filename: "nested.mp4",
          },
        },
      );
      expect(response.ok(), await response.text()).toBe(true);
      const { jobId } = z
        .object({ jobId: z.string() })
        .parse(await response.json());
      const jobSchema = z.object({
        status: z.string(),
        outputPath: z.string().optional(),
        error: z.string().nullable().optional(),
      });
      let output: string | undefined;
      await expect
        .poll(
          async () => {
            const job = jobSchema.parse(
              await (await request.get(`/api/render/${jobId}`)).json(),
            );
            if (job.status === "failed")
              throw Error(job.error ?? "Export failed");
            output = job.outputPath;
            return job.status;
          },
          { timeout: 90000 },
        )
        .toBe("complete");
      const image = info.outputPath("exported.png");
      await promisify(execFile)("ffmpeg", [
        "-v",
        "error",
        "-i",
        output!,
        "-frames:v",
        "1",
        image,
      ]);
      const { stdout } = await promisify(execFile)(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          image,
          "-vf",
          "crop=1150:160:50:510,format=rgb24",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { encoding: "buffer", maxBuffer: 2000000 },
      );
      let bright = 0;
      for (let i = 0; i < stdout.length; i += 3)
        if (stdout[i] > 90 && stdout[i + 1] > 90 && stdout[i + 2] > 90)
          bright++;
      expect(bright).toBeGreaterThan(1000);
    }
    console.log(
      JSON.stringify({
        r3: kind,
        before,
        after,
        scriptUnchanged: true,
        toast: toastMessage,
      }),
    );
  });
