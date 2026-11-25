import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

test("MCP ripple names every other track it cuts in the reply and Changes row", async ({
  page,
  request,
  baseURL,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Ripple tracks", width: 320, height: 240, duration: 8 },
      })
    ).json(),
  );
  const projectApi = `/api/cutroom/projects/${project.id}`;
  const wav = Bun.spawnSync([
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=8000:cl=mono",
    "-t",
    "8",
    join(project.path, "silent.wav"),
  ]);
  expect(wav.exitCode, wav.stderr.toString()).toBe(0);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><main data-composition-id="main" data-fps="30" data-width="320" data-height="240" data-duration="8">
    <div id="pause-a" class="clip" data-start="1" data-duration="1" data-track-index="0">Pause one</div>
    <div id="pause-b" class="clip" data-start="4" data-duration="1" data-track-index="0">Pause two</div>
    <audio id="voice" src="silent.wav" data-start="0" data-duration="8" data-track-index="1"></audio>
    <audio id="music" src="silent.wav" data-start="0" data-duration="8" data-track-index="2"></audio>
    <audio id="locked" src="silent.wav" data-start="0" data-duration="8" data-track-index="3"></audio>
    <audio id="trailing" src="silent.wav" data-start="6" data-duration="2" data-track-index="4"></audio>
  </main>`,
  );
  const timeline = async () =>
    TimelineViewSchema.parse(
      await (await request.get(projectApi + "/timeline")).json(),
    );
  const configured = await request.post(projectApi + "/commands", {
    data: {
      expectedRevision: (await timeline()).revision,
      commands: [
        { type: "setTrack", index: 1, name: "Voiceover" },
        { type: "setTrack", index: 2, name: "Music", autoSelect: false },
        { type: "setTrack", index: 3, name: "Locked", locked: true },
        { type: "setTrack", index: 4, name: "Trailing" },
      ],
    },
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  await page.goto(`/#project/${project.id}`);
  const client = new Client({ name: "ripple-proof", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const reply = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: (await timeline()).revision,
        commands: [
          { type: "remove", clipIds: ["pause-a", "pause-b"], ripple: true },
        ],
      },
    });
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
    const text = z
      .array(z.object({ text: z.string() }))
      .parse(reply.content)
      .at(-1)?.text;
    expect(text).toContain("also cut Voiceover in 2 places");
    expect(text).toContain("Music in 2 places");
    expect(text).not.toContain("Locked");
    expect(text).not.toContain("Trailing");
    expect(reply.structuredContent).toMatchObject({
      result: {
        rippleCuts: [
          { track: 1, name: "Voiceover", count: 2, framesRemoved: 60 },
          { track: 2, name: "Music", count: 2, framesRemoved: 60 },
        ],
      },
    });
    const { clips } = (await timeline()).timeline;
    expect(
      clips.filter(({ track }) => track === 1).map(({ duration }) => duration),
    ).toEqual([30, 60, 90]);
    expect(
      clips.filter(({ track }) => track === 2).map(({ duration }) => duration),
    ).toEqual([30, 60, 90]);
    expect(clips.filter(({ track }) => track === 3)).toMatchObject([
      { id: "locked", start: 0, duration: 240 },
    ]);
    expect(clips.filter(({ track }) => track === 4)).toMatchObject([
      { id: "trailing", start: 120, duration: 60 },
    ]);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    const row = page
      .getByRole("list", { name: "Composition changes" })
      .getByRole("listitem")
      .filter({ hasText: "Ripple deleted" });
    await expect(row).toContainText("also cut Voiceover in 2 places");
    await expect(row).toContainText("Music in 2 places");
    expect(await row.count()).toBe(1);
  } finally {
    await client.close();
  }
});
