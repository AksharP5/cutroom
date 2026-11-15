import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createMcpServer } from "../src/server/mcp/server";
import { projectFixture } from "./project-fixture";

test("project_lint reports HyperFrames findings without snippets, errors first", async () => {
  const project = await projectFixture();
  const editor = createHyperframesApi(project.store, project.review);
  project.app.route("/api", editor);
  const server = createMcpServer({
    fetch: (url, init) => project.app.request(url, init),
  });
  const client = new Client({ name: "lint-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(remote);
    await client.connect(local);
    const created = await project.store.create({ name: "Lint" });
    await writeFile(
      join(created.path, "index.html"),
      `<!doctype html><html><body><main data-composition-id="main" data-fps="30" data-width="1920" data-height="1080" data-duration="8" data-no-timeline>
<video id="broll" class="clip" data-start="0" data-duration="3" data-track-index="0" src="assets/broll.mp4"></video>
</main></body></html>`,
    );
    const answer = await client.callTool({
      name: "project_lint",
      arguments: { projectId: created.id },
    });
    expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
    const lint = z
      .object({
        structuredContent: z.object({
          result: z.object({
            errors: z.number(),
            warnings: z.number(),
            findings: z.array(z.record(z.string(), z.unknown())),
          }),
        }),
      })
      .parse(answer).structuredContent.result;
    expect(lint.errors).toBeGreaterThan(0);
    expect(lint.findings[0]?.severity).toBe("error");
    expect(lint.findings).toContainEqual(
      expect.objectContaining({
        code: "video_missing_muted",
        severity: "error",
        elementId: "broll",
        file: "index.html",
        line: 2,
      }),
    );
    expect(JSON.stringify(lint)).not.toContain("snippet");
  } finally {
    await client.close();
    await server.close();
    await editor.dispose();
    await project.close();
  }
});
