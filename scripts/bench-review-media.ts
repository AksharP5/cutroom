import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { clipVersions } from "../src/server/projects/changes";
import { createProjectStore } from "../src/server/projects/store";
import { createReviewService } from "../src/server/projects/review";
import { createTimelineRoutes } from "../src/server/timeline/routes";

const directory = await mkdtemp(join(tmpdir(), "review-media-"));
const store = await createProjectStore({
  dataDir: join(directory, "data"),
  projectsDir: join(directory, "projects"),
});
try {
  const project = await store.create({ name: "500 media clips" });
  await mkdir(`${project.path}/assets`, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  await Promise.all(
    Array.from({ length: 500 }, (_, i) =>
      writeFile(`${project.path}/assets/card-${i}.png`, png),
    ),
  );
  const review = createReviewService(store);
  const app = new Hono().route("/api", createTimelineRoutes(store, review));
  const measure = async (
    run: (i: number) => Promise<unknown>,
    prepare?: (i: number) => Promise<void>,
  ) => {
    const times: number[] = [];
    for (let i = 0; i < 70; i++) {
      await prepare?.(i);
      const start = performance.now();
      await run(i);
      if (i >= 10) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return {
      p50Ms: +times[Math.floor(times.length * 0.5)]!.toFixed(3),
      p95Ms: +times[Math.floor(times.length * 0.95)]!.toFixed(3),
    };
  };
  const results = [];
  for (const uniqueMedia of [1, 500]) {
    const clips = Array.from(
      { length: 500 },
      (_, i) =>
        `<img id="clip-${i}" class="clip group-${i % 10}" src="assets/card-${i % uniqueMedia}.png" data-start="${i}" data-duration="1" data-track-index="0" alt="Clip ${i}">`,
    ).join("\n");
    const source = (revision: number) =>
      `<html><head><style>body{background:black}</style></head><body><main data-composition-id="main" data-duration="500">${clips}</main><script>const revision=${revision};</script></body></html>`;
    const save = (revision: number) =>
      writeFile(`${project.path}/index.html`, source(revision));
    await save(0);
    await review.editComposition(project, "index.html", "external", () =>
      save(1),
    );
    const signatureChanged = await measure(
      () => clipVersions(project, "index.html"),
      save,
    );
    const signatureUnchanged = await measure(() =>
      clipVersions(project, "index.html"),
    );
    const timeline = async () => {
      const response = await app.request(
        `/api/projects/${project.id}/timeline`,
      );
      if (response.status !== 200) throw new Error(await response.text());
      await response.json();
    };
    const timelineChanged = await measure(timeline, save);
    const timelineUnchanged = await measure(timeline);
    results.push({
      clips: 500,
      uniqueMedia,
      bytes: source(0).length,
      signatureChanged,
      signatureUnchanged,
      timelineChanged,
      timelineUnchanged,
    });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await store.close();
  await rm(directory, { recursive: true, force: true });
}
