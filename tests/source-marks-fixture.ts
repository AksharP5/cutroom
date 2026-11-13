import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";

export async function sourceMarksFixture() {
  const f = await projectFixture();
  f.app.route("/api/cutroom", createTimelineRoutes(f.store, f.review));
  const project = await f.store.create({ name: "Reviewed marks" });
  const path = join(project.path, "talk.wav");
  const make = (seconds: number, sampleRate = 44100) =>
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=duration=${seconds}`,
      "-ar",
      String(sampleRate),
      path,
    ]);
  make(12);
  const endpoint = `/projects/${project.id}`;
  return { ...f, project, path, make, endpoint };
}
