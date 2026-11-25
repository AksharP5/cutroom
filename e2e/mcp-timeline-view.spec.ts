import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

test("timeline_view draws alternating far seeks in one long source", async ({
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const response = await request.post("/api/cutroom/projects", {
    data: { name: "Long take", duration: 1, width: 320, height: 240 },
  });
  const body: unknown = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  const project = ProjectSchema.parse(body);
  const video = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=96x54:r=60:d=1800",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=8000:duration=1800",
    "-vf",
    "drawbox=color=blue:t=fill:enable=gte(t\\,900),select=not(eq(mod(n\\,5)\\,2))",
    "-fps_mode",
    "vfr",
    "-c:a",
    "aac",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-g",
    "120",
    "-x265-params",
    "pools=2:log-level=error",
    join(project.path, "take.mkv"),
  ]);
  expect(video.status, video.stderr?.toString() ?? video.error?.message).toBe(
    0,
  );
  await writeFile(
    join(project.path, "index.html"),
    '<!doctype html><style>body{margin:0}video{position:absolute;inset:0;width:100%;height:100%}</style><main data-composition-id="main" data-width="96" data-height="54" data-fps="60" data-duration="1400"><video class="clip" id="take" src="take.mkv" muted data-start="0" data-duration="1400" data-media-start="351.4" data-track-index="0"></video></main>',
  );
  const client = new Client({ name: "Long take proof", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const picture = z.object({ type: z.literal("image"), data: z.string() });
    const errors: string[] = [];
    const check = async (frames: number[]) => {
      const started = performance.now();
      const reply = await client.callTool({
        name: "timeline_view",
        arguments: {
          projectId: project.id,
          ...(frames.length === 1 ? { frame: frames[0] } : { frames }),
        },
      });
      if (reply.isError) {
        errors.push(JSON.stringify(reply.content));
        return;
      }
      console.log(
        `${frames.join(", ")} in ${Math.round(performance.now() - started)} ms`,
      );
      for (const [index, frame] of frames.entries()) {
        const image = picture.parse(
          z.array(z.unknown()).parse(reply.content)[2 * index],
        );
        const pixel = spawnSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-f",
            "mjpeg",
            "-i",
            "pipe:0",
            "-vf",
            "crop=2:2:48:26",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
          ],
          { input: Buffer.from(image.data, "base64") },
        );
        expect(
          pixel.status,
          pixel.stderr?.toString() ?? pixel.error?.message,
        ).toBe(0);
        const [red, , blue] = pixel.stdout;
        if ((frame < 32_916 ? red! - blue! : blue! - red!) <= 200)
          errors.push(`Frame ${frame} drew red=${red}, blue=${blue}`);
      }
    };
    for (const frame of [15_001, 45_002, 12_003, 48_004]) await check([frame]);
    await check([13_003, 46_005, 32_915, 32_916]);
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});
