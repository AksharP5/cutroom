import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

test("Inspector, R, and MCP resize linked clips, ripple the cut, with undo for the owner and MCP session", async ({
  page,
  request,
  baseURL,
}) => {
  const created = await request.post("/api/cutroom/projects", {
    data: {
      name: "Constant speed ripple",
      width: 320,
      height: 240,
      duration: 6,
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const project = ProjectSchema.parse(await created.json());
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x240:r=30:d=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:d=10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-threads",
    "1",
    "-c:a",
    "aac",
    join(project.path, "take.mp4"),
  ]);
  const file = join(project.path, "index.html");
  const original = `<!doctype html><html><head><style>video{position:absolute;width:320px;height:240px}</style></head><body><main data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="6">
<video id="shot" src="take.mp4" muted data-start="0" data-duration="4" data-media-start="1" data-link="pair" data-track-index="0"></video>
<audio id="sound" src="take.mp4" data-start="0" data-duration="4" data-media-start="1" data-link="pair" data-track-index="1"></audio>
<video id="next" src="take.mp4" muted data-start="4" data-duration="2" data-media-start="5" data-track-index="0"></video>
</main></body></html>`;
  await writeFile(file, original);
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  const geometry = async () => {
    const { timeline } = await read();
    return Object.fromEntries(
      timeline.clips.map(
        ({ id, start, duration, mediaStart, playbackRate }) => [
          id,
          [start, duration, mediaStart, playbackRate],
        ],
      ),
    );
  };
  const atDouble = {
    shot: [0, 60, 1, 2],
    sound: [0, 60, 1, 2],
    next: [60, 60, 5, 1],
  };
  const undo = async () => {
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(() => readFile(file, "utf8")).toBe(original);
  };
  await page.goto(`/#project/${project.id}`);
  const shot = page.locator('[data-clip="shot"]');
  const speed = page.getByRole("textbox", { name: "Speed", exact: true });
  const enterSpeed = async (value: string) => {
    await speed.fill(value);
    await speed.press("Enter");
  };

  await shot.click();
  await enterSpeed("200%");
  await expect.poll(geometry).toEqual(atDouble);
  await expect(
    page.getByRole("textbox", { name: "Duration", exact: true }),
  ).toHaveValue("00:00:02:00");
  await undo();

  await shot.click();
  await page.keyboard.press("r");
  await expect(speed).toBeFocused();
  await enterSpeed("200%");
  await expect.poll(geometry).toEqual(atDouble);
  await undo();

  const client = new Client({ name: "constant-speed-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL!), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const response = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: (await read()).revision,
        commands: [{ type: "setTiming", clipId: "shot", playbackRate: 0.5 }],
      },
    });
    expect(response.isError, JSON.stringify(response.content)).toBeFalsy();
    await expect.poll(geometry).toEqual({
      shot: [0, 240, 1, 0.5],
      sound: [0, 240, 1, 0.5],
      next: [240, 60, 5, 1],
    });
    await expect(speed).toHaveValue("50%");
    const reversed = await client.callTool({
      name: "history_undo",
      arguments: { projectId: project.id },
    });
    expect(reversed.isError, JSON.stringify(reversed.content)).not.toBe(true);
    await expect.poll(() => readFile(file, "utf8")).toBe(original);
  } finally {
    await client.close();
  }
});
