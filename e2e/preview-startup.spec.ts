import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

const ffmpeg = promisify(execFile);
const cuts = 400;

test("a long timeline's frame capture starts without a page-wide animation snapshot per clip", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Many cuts", width: 640, height: 360, duration: 2 },
      })
    ).json(),
  );
  await ffmpeg("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=0x405ac5:s=640x360:r=30:d=2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    join(project.path, "talk.mp4"),
  ]);
  // A talking-head cut: hundreds of short pieces of one file, the shape of a real edit. A root
  // with no declared length, as deleting every clip leaves it, takes its length from its clips.
  const file = join(project.path, "index.html");
  await writeFile(
    file,
    (await readFile(file, "utf8"))
      .replace(/data-duration="[^"]*"/, 'data-duration="0"')
      .replace(
        "</main>",
        `${Array.from(
          { length: cuts },
          (_, index) =>
            `<video id="cut-${index}" muted src="talk.mp4" data-start="${index / 10}" data-duration="0.1" data-media-start="0.5" data-track-index="0"></video>`,
        ).join("")}</main>`,
      ),
  );
  // Each document.getAnimations() flushes style for the whole composition. Startup used to take
  // one per media element while it bound each to the composition's length: about 2 s at 1,000.
  await page.addInitScript(() => {
    const snapshot = Document.prototype.getAnimations;
    let count = 0;
    Document.prototype.getAnimations = function () {
      count += 1;
      return snapshot.call(this);
    };
    Object.defineProperty(window, "__snapshots", { get: () => count });
  });
  // The document Home's poster and an agent's frame checks capture, outside the editor's pipeline.
  await page.goto(
    `/api/projects/${project.id}/isolated-preview?v=1&document=startup`,
  );
  await page.waitForFunction(() => Reflect.get(window, "__renderReady"));
  const snapshots = await page.evaluate(
    () => Reflect.get(window, "__snapshots") as number,
  );
  expect(snapshots).toBeGreaterThan(0);
  expect(snapshots).toBeLessThan(cuts / 4);
});
