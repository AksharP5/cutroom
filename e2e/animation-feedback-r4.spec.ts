import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { test, expect } from "./fixtures";

type Tween = { targets(): unknown[]; startTime(): number };
type Timeline = {
  getChildren(nested: boolean, tweens: boolean, timelines: boolean): Tween[];
};
const fixture = (name: string) =>
  readFile(
    new URL(
      `./fixtures/animation-feedback/review-r4/${name}.html`,
      import.meta.url,
    ),
    "utf8",
  );
const run = promisify(execFile);
for (const kind of [
  "autoVideoFront",
  "noscriptScript",
  "pastedExecutable",
  "svgUse",
  "smil",
  "tableOwner",
]) {
  test(`R4 ${kind}: edit preserves tween seconds in the editor and MP4`, async ({
    page,
    request,
  }, info) => {
    test.setTimeout(120000);
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: `R4 ${kind}` },
        })
      ).json(),
    );
    const file = join(project.path, "index.html");
    const original = await fixture(kind);
    await writeFile(file, original);
    await copyFile(
      join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
      join(project.path, "gsap.min.js"),
    );
    if (kind === "autoVideoFront")
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=white:s=128x72:r=30:d=20",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        join(project.path, "sample.mp4"),
      ]);
    if (kind === "pastedExecutable")
      await writeFile(
        join(project.path, "payload.html"),
        await fixture("payload"),
      );
    const connected = page.waitForRequest((r) =>
      r.url().includes(`/projects/${project.id}/events`),
    );
    await page.goto(`/#project/${project.id}`);
    const origin =
      new URL((await connected).url()).searchParams.get("origin") ?? "";
    await expect(page.locator('[data-clip="cta"]')).toBeVisible();
    const body = page.frameLocator("iframe[data-live]").locator("body");
    const sample = () =>
      body.evaluate(() => {
        const root = (
          window as typeof window & { __timelines: Record<string, Timeline> }
        ).__timelines.main;
        return root.getChildren(true, true, false).flatMap((tween) =>
          tween
            .targets()
            .filter((node): node is Element => node instanceof Element)
            .map((node) => ({
              id: node.id,
              tag: node.tagName,
              at: tween.startTime(),
            })),
        );
      });
    const seek = async () => {
      await page.getByRole("button", { name: /^Current time/ }).click();
      await page.getByLabel("Go to time").pressSequentially("0500");
      await page.keyboard.press("Enter");
    };
    await seek();
    const before = await sample();
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((entry) => entry.at === 4)).toBe(true);
    await page.screenshot({ path: info.outputPath("before.png") });
    if (kind === "pastedExecutable") {
      const timeline = () =>
        request
          .get(`/api/cutroom/projects/${project.id}/timeline`)
          .then(async (response) =>
            TimelineViewSchema.parse(await response.json()),
          );
      const snapshot = await timeline();
      const copied = z.object({ id: z.string() }).parse(
        await (
          await request.post(
            `/api/cutroom/projects/${project.id}/timeline/copy`,
            {
              data: {
                composition: "payload.html",
                clipIds: ["payload"],
                expectedRevision: (
                  await request
                    .get(
                      `/api/cutroom/projects/${project.id}/timeline?composition=payload.html`,
                    )
                    .then(async (response) =>
                      TimelineViewSchema.parse(await response.json()),
                    )
                ).revision,
              },
            },
          )
        ).json(),
      );
      const response = await request.post(
        `/api/cutroom/projects/${project.id}/commands`,
        {
          headers: { "x-cutroom-tab-origin": origin },
          data: {
            expectedRevision: snapshot.revision,
            commands: [
              { type: "setTrack", index: 1, autoSelect: false },
              {
                type: "paste",
                clipboardId: copied.id,
                at: 0,
                mode: "insert",
                ids: { payload: ["pasted"] },
              },
            ],
          },
        },
      );
      expect(response.ok(), await response.text()).toBe(true);
    } else {
      await page.locator('[data-clip="cta"]').click();
      const start = page
        .getByRole("complementary", { name: "Inspector" })
        .getByRole("textbox", { name: "Start", exact: true });
      await start.fill("6s");
      await start.press("Enter");
    }
    await expect.poll(() => readFile(file, "utf8")).toContain('id="cta"');
    await expect(body.locator('[id="cta"][data-start]')).toHaveAttribute(
      "data-start",
      "6",
    );
    const written = await readFile(file, "utf8");
    expect(written.match(/<script>[^]*?<\/script>/g)?.at(-1)).toBe(
      original.match(/<script>[^]*?<\/script>/g)?.at(-1),
    );
    const toast = page
      .getByRole("status")
      .filter({ hasText: /cta's animation stayed/ });
    await expect(toast).toHaveCount(1);
    await expect(toast).toBeVisible();
    const toastMessage = await toast.innerText();
    await expect(
      toast.getByRole("button", { name: "Ask agent", exact: true }),
    ).toBeVisible();
    const after = await sample();
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((entry) => entry.at === 4)).toBe(true);
    await seek();
    await page.screenshot({ path: info.outputPath("warning.png") });
    const directory = info.outputPath("export");
    await mkdir(directory, { recursive: true });
    const response = await request.post(`/api/projects/${project.id}/export`, {
      data: {
        range: { start: 150, end: 153 },
        quality: "draft",
        directory,
        filename: "warning.mp4",
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const { jobId } = z
      .object({ jobId: z.string() })
      .parse(await response.json());
    let output: string | undefined;
    await expect
      .poll(
        async () => {
          const job = z
            .object({
              status: z.string(),
              outputPath: z.string().optional(),
              error: z.string().nullable().optional(),
            })
            .parse(await (await request.get(`/api/render/${jobId}`)).json());
          if (job.status === "failed")
            throw Error(job.error ?? "Export failed");
          output = job.outputPath;
          return job.status;
        },
        { timeout: 90000 },
      )
      .toBe("complete");
    const image = info.outputPath("exported.png");
    await run("ffmpeg", [
      "-v",
      "error",
      "-i",
      output!,
      "-frames:v",
      "1",
      image,
    ]);
    const { stdout } = await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        image,
        "-vf",
        kind === "tableOwner"
          ? "crop=1200:90:0:0,format=rgb24"
          : "crop=1200:300:0:360,format=rgb24",
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
      if (stdout[i] > 90 && stdout[i + 1] > 90 && stdout[i + 2] > 90) bright++;
    expect(bright).toBeGreaterThan(500);
    console.log(
      JSON.stringify({
        r4: kind,
        before,
        after,
        scriptUnchanged: true,
        toast: toastMessage,
        exportBrightPixels: bright,
      }),
    );
  });
}
