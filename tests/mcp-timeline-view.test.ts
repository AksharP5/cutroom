import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";

/** A JPEG's pixel size, read from its start-of-frame marker. */
function jpegSize(bytes: Uint8Array) {
  for (let at = 2; at < bytes.length;) {
    const marker = bytes[at + 1]!;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (marker >= 0xc0 && marker <= 0xc3)
      return {
        height: (bytes[at + 5]! << 8) | bytes[at + 6]!,
        width: (bytes[at + 7]! << 8) | bytes[at + 8]!,
      };
    at += 2 + length;
  }
  throw new Error("No JPEG frame header.");
}

test("timeline_view renders several frames in one call at a chosen width", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "View" });
  // Frame capture needs Chromium; a full-size frame stands in for its output.
  const frame = await new Response(
    Bun.spawn(
      [
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1920x1080",
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "pipe:1",
      ],
      { stdout: "pipe" },
    ).stdout,
  ).bytes();
  const seeks: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => {
        if (!url.includes("/thumbnail/")) return fixture.app.request(url, init);
        seeks.push(new URL(url).searchParams.get("t") ?? "");
        return new Response(frame);
      },
    }),
  });
  const client = new Client({ name: "view-test", version: "1" });
  const Images = z.object({
    content: z.array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("image"), data: z.string() }),
        z.object({ type: z.literal("text"), text: z.string() }),
      ]),
    ),
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const view = (args: Record<string, unknown>) =>
      client.callTool({
        name: "timeline_view",
        arguments: { projectId: project.id, ...args },
      });
    const { content } = Images.parse(
      await view({ frames: [0, 15, 30], width: 480 }),
    );
    expect(seeks).toEqual(["0", "0.5", "1"]);
    expect(
      content.map((block) =>
        block.type === "image"
          ? jpegSize(Buffer.from(block.data, "base64"))
          : block.text,
      ),
    ).toEqual([
      { width: 480, height: 270 },
      "Frame 0 (0.000s)",
      { width: 480, height: 270 },
      "Frame 15 (0.500s)",
      { width: 480, height: 270 },
      "Frame 30 (1.000s)",
    ]);
    // Never scaled up past the composition, and full size without a width.
    for (const width of [3840, undefined]) {
      const [image] = Images.parse(await view({ frame: 1, width })).content;
      expect(
        image?.type === "image" && jpegSize(Buffer.from(image.data, "base64")),
      ).toEqual({ width: 1920, height: 1080 });
    }
    expect((await view({})).isError).toBe(true);
    expect((await view({ frame: 1, frames: [2] })).isError).toBe(true);
    expect(
      (await view({ frames: Array.from({ length: 9 }, (_, i) => i) })).isError,
    ).toBe(true);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});
