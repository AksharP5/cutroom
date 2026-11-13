import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../src/shared/errors";
import { Hono } from "hono";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import {
  SourceMarksSaveSchema,
  SourceMarksSchema,
} from "../src/shared/timeline/view";
import { projectFixture } from "./project-fixture";

test("source marks share the view save queue, survive reopening, and ignore renamed or replaced files", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Source marks" });
  const routes = () =>
    new Hono()
      .onError((error, c) =>
        c.json(
          { error: error.message },
          error instanceof HttpError ? error.status : 500,
        ),
      )
      .route("/", createTimelineRoutes(fixture.store, fixture.review));
  const app = routes();
  const endpoint = `/projects/${project.id}`;
  const media = join(project.path, "clip.wav");
  const marks = { in: 2, out: 5 };
  const make = (path: string, seconds: number) =>
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=duration=${seconds}`,
      path,
    ]);
  const save = async (path: string, body: Record<string, unknown>) => {
    const identity = path.startsWith("/source-marks?")
      ? SourceMarksSaveSchema.parse(
          await (await app.request(`${endpoint}${path}`)).json(),
        ).identity
      : undefined;
    return app.request(`${endpoint}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, ...(identity && { identity }) }),
    });
  };
  const read = async (path: string, api = app) =>
    SourceMarksSchema.parse(
      await (await api.request(`${endpoint}/source-marks?path=${path}`)).json(),
    );
  try {
    make(media, 12);
    make(join(project.path, "other.wav"), 8);
    // Timeline preferences and source marks share one view file.
    await save("/timeline-view", { destinations: { video: 2 } });
    const ledger = await fixture.store.history(project);
    await ledger.checkpoint();
    const initial = ledger.list();
    const responses = await Promise.all([
      save("/source-marks?path=clip.wav", marks),
      save("/source-marks?path=other.wav", { in: null, out: 1 }),
      save("/timeline-view", { density: "tall", destinations: { video: 2 } }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(await read("./clip.wav", routes())).toEqual(marks);
    expect(await read("other.wav", routes())).toEqual({ in: null, out: 1 });
    expect(
      JSON.parse(
        await readFile(join(project.path, ".cutroom/view.json"), "utf8"),
      ),
    ).toMatchObject({
      timelines: {
        "index.html": { density: "tall", destinations: { video: 2 } },
      },
    });
    await ledger.checkpoint();
    expect(ledger.list()).toEqual(initial);
    expect(
      (await save("/source-marks?path=clip.wav", { in: 5, out: 2 })).status,
    ).toBe(400);
    expect(await read("clip.wav")).toEqual(marks);
    await rename(media, join(project.path, "renamed.wav"));
    expect(await read("renamed.wav")).toEqual({ in: null, out: null });
    expect(
      (await app.request(`${endpoint}/source-marks?path=clip.wav`)).status,
    ).toBe(404);
    make(media, 3);
    expect(await read("clip.wav")).toEqual({ in: null, out: null });
  } finally {
    await fixture.close();
  }
});
