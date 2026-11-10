import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";

test("rendered video tracks stack upward after insert and track moves, while authored z-index wins", async ({
  request,
}, testInfo) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Title above footage",
          width: 640,
          height: 360,
          duration: 2,
        },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x265878:s=640x360:r=30:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(project.path, "footage.mp4"),
  ]);
  const path = `/api/cutroom/projects/${project.id}`;
  let view = TimelineViewSchema.parse(
    await (await request.get(`${path}/timeline`)).json(),
  );
  const edit = async (commands: CommandInput[]) => {
    const response = await request.post(`${path}/commands`, {
      data: { expectedRevision: view.revision, commands },
    });
    expect(response.ok(), await response.text()).toBe(true);
    view = TimelineViewSchema.parse(await response.json());
    expect(
      TimelineViewSchema.parse(
        await (await request.get(`${path}/timeline`)).json(),
      ),
    ).toEqual(view);
  };
  const whitePixels = async (name: string) => {
    const response = await request.get(
      `/api/projects/${project.id}/thumbnail/index.html?t=1&format=png&output=source`,
    );
    expect(response.ok(), response.statusText()).toBe(true);
    const frame = testInfo.outputPath(`${name}.png`);
    await writeFile(frame, await response.body());
    await testInfo.attach(name, { path: frame, contentType: "image/png" });
    const raw = testInfo.outputPath(`${name}.rgb`);
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-i",
      frame,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      raw,
    ]);
    const pixels = await readFile(raw);
    let white = 0;
    for (let offset = 0; offset < pixels.length; offset += 3)
      if (
        pixels[offset]! > 200 &&
        pixels[offset + 1]! > 200 &&
        pixels[offset + 2]! > 200
      )
        white++;
    return white;
  };
  await edit([
    { type: "remove", clipIds: ["rule", "caption"] },
    { type: "setTrack", index: 0, name: "Footage" },
    { type: "setTrack", index: 2, name: "Titles" },
    {
      type: "insert",
      track: 0,
      at: 0,
      clip: {
        id: "footage",
        kind: "video",
        src: "footage.mp4",
        duration: 60,
        muted: true,
      },
    },
  ]);
  expect(await whitePixels("inserted-on-v1")).toBeGreaterThan(100);
  await edit([{ type: "move", clipIds: ["headline"], trackBy: 1 }]);
  expect(await whitePixels("title-on-v3")).toBeGreaterThan(100);
  await edit([{ type: "move", clipIds: ["footage"], trackBy: 3 }]);
  expect(await whitePixels("footage-above-title")).toBe(0);
  await edit([{ type: "move", clipIds: ["footage"], trackBy: -3 }]);
  expect(await whitePixels("footage-back-on-v1")).toBeGreaterThan(100);

  const source = SourceSchema.parse(
    await (await request.get(`${path}/source`)).json(),
  );
  const written = await request.put(`${path}/source`, {
    data: {
      path: "index.html",
      expectedVersion: source.version,
      content: source.content.replace("</style>", ".title{z-index:50}</style>"),
    },
  });
  expect(written.ok()).toBe(true);
  view = TimelineViewSchema.parse(
    await (await request.get(`${path}/timeline`)).json(),
  );
  await edit([{ type: "move", clipIds: ["footage"], trackBy: 3 }]);
  expect(await whitePixels("authored-css-wins")).toBeGreaterThan(100);
});
