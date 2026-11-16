import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderWorkers } from "../src/server/hyperframes/jobs";
import { browserExecutable } from "../src/server/hyperframes/render";

/** The middle pixel of an export's first frame, as RGB. */
async function middlePixel(path: string) {
  const child = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      "crop=w=2:h=2:x=80:y=60,scale=1:1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  return [...bytes];
}

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "an export renders the variables it is given, whole or marked",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "variables-export-"));
    const scratchDir = `${root}-scratch`;
    const workers = createRenderWorkers({ scratchDir });
    try {
      await writeFile(
        join(root, "index.html"),
        `<!doctype html><html data-composition-variables='[{"id":"accent","type":"color","label":"Accent","default":"#ff0000"}]'><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}#plate{position:absolute;inset:0;background:var(--accent)}</style></head><body><main data-composition-id="main" data-width="160" data-height="120" data-duration="1" style="position:relative;width:160px;height:120px"><div id="plate" class="clip" data-start="0" data-duration="1" data-track-index="0"></div></main></body></html>`,
      );
      for (const range of [null, { start: 5, end: 10 }]) {
        const name = range ? "marked" : "whole";
        const outputPath = join(root, `${name}.mp4`);
        const state = workers.start(
          {
            project: { id: "variables", dir: root },
            outputPath,
            format: "mp4",
            fps: { num: 30, den: 1 },
            quality: "high",
            jobId: name,
            variables: { accent: "#0000ff" },
          },
          { filename: `${name}.mp4`, directory: root, range },
        );
        const deadline = Date.now() + 45000;
        while (state.status === "rendering" && Date.now() < deadline)
          await Bun.sleep(20);
        expect(state.error).toBeUndefined();
        expect(state.status).toBe("complete");
        const [red, green, blue] = await middlePixel(outputPath);
        // The override's blue, not the default's red, within H.264's rounding.
        expect(red).toBeLessThan(20);
        expect(green).toBeLessThan(20);
        expect(blue).toBeGreaterThan(230);
      }
    } finally {
      await workers.cancelAll();
      await rm(root, { recursive: true, force: true });
      await rm(scratchDir, { recursive: true, force: true });
    }
  },
  90_000,
);
