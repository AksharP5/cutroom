import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ExportJobSchema, RendersSchema } from "../src/shared/export";
import { AGENT_HEADER } from "../src/shared/review";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createRenderIndex } from "../src/server/hyperframes/renders";
import { browserExecutable } from "../src/server/hyperframes/render";
import { createMcpServer } from "../src/server/mcp/server";
import { projectFixture } from "./project-fixture";

/**
 * A render is Cutroom's to list and delete when it sits in the project's `.cutroom/renders`, or
 * when Cutroom recorded publishing it elsewhere and the file is still the one it wrote. Nothing
 * else, however it is named or linked, can be listed or deleted.
 */
test("the renders list holds only files Cutroom wrote, and delete refuses everything else", async () => {
  const root = await mkdtemp(join(tmpdir(), "renders-"));
  try {
    const project = { path: join(root, "project") };
    const renders = join(project.path, ".cutroom", "renders");
    const elsewhere = join(root, "deliveries");
    await mkdir(renders, { recursive: true });
    await mkdir(elsewhere);
    await writeFile(join(project.path, "index.html"), "<html></html>");
    await writeFile(join(renders, "Cut.mp4"), "mp4");
    await writeFile(join(renders, "Cut 00-00-01-00.png"), "png");
    await writeFile(join(renders, "job.meta.json"), "{}");
    // A link in Cutroom's folder must not expose, or delete, what it points to.
    await symlink(join(project.path, "index.html"), join(renders, "Link.mp4"));
    await writeFile(join(elsewhere, "Overlay.mov"), "mov");
    await writeFile(join(elsewhere, "Theirs.mov"), "someone else's");
    const index = createRenderIndex();
    await index.record(project, join(elsewhere, "Overlay.mov"));
    const listed = await index.list(project);
    expect(listed.map((render) => [render.path, render.format])).toEqual(
      expect.arrayContaining([
        [join(renders, "Cut.mp4"), "mp4"],
        [join(elsewhere, "Overlay.mov"), "mov"],
      ]),
    );
    expect(listed).toHaveLength(2);

    for (const path of [
      join(elsewhere, "Theirs.mov"),
      join(renders, "Link.mp4"),
      join(project.path, "index.html"),
    ])
      await expect(index.remove(project, path)).rejects.toThrow(
        "not one of this project's renders",
      );
    expect((await readdir(elsewhere)).sort()).toEqual([
      "Overlay.mov",
      "Theirs.mov",
    ]);
    expect(await readdir(project.path)).toContain("index.html");

    // Once someone else changes the file it is no longer the render Cutroom wrote.
    await appendFile(join(elsewhere, "Overlay.mov"), " edited");
    expect((await index.list(project)).map((render) => render.path)).toEqual([
      join(renders, "Cut.mp4"),
    ]);
    await expect(
      index.remove(project, join(elsewhere, "Overlay.mov")),
    ).rejects.toThrow();
    expect(await readdir(elsewhere)).toContain("Overlay.mov");

    await index.remove(project, join(renders, "Cut.mp4"));
    expect(await readdir(renders)).not.toContain("Cut.mp4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "an export saved to another folder is listed for agents, and only the owner can delete it",
  async () => {
    const f = await projectFixture();
    const editor = createHyperframesApi(f.store, f.review);
    f.app.route("/api", editor);
    const server = createMcpServer({
      fetch: (url, init) => f.app.request(url, init),
    });
    const client = new Client({ name: "renders-test", version: "1" });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await server.connect(remote);
    await client.connect(local);
    try {
      const p = await f.store.create({
        name: "Delivery",
        duration: 1,
        width: 320,
        height: 240,
      });
      const directory = join(f.directory, "deliveries");
      await mkdir(directory);
      const started = z
        .object({
          structuredContent: z.object({
            result: z.object({ jobId: z.string(), outputPath: z.string() }),
          }),
        })
        .parse(
          await client.callTool({
            name: "export_start",
            arguments: { projectId: p.id, directory, format: "webm" },
          }),
        ).structuredContent.result;
      const status = async () =>
        ExportJobSchema.parse(
          await (await f.app.request(`/api/render/${started.jobId}`)).json(),
        );
      const deadline = Date.now() + 60_000;
      while ((await status()).status === "rendering" && Date.now() < deadline)
        await Bun.sleep(100);
      expect((await status()).status).toBe("complete");

      const listed = RendersSchema.parse(
        z
          .object({ structuredContent: z.object({ result: z.unknown() }) })
          .parse(
            await client.callTool({
              name: "export_list",
              arguments: { projectId: p.id },
            }),
          ).structuredContent.result,
      ).renders;
      expect(listed.map((render) => [render.path, render.format])).toEqual([
        [started.outputPath, "webm"],
      ]);

      const remove = (headers: Record<string, string>) =>
        f.app.request(`/api/projects/${p.id}/exports`, {
          method: "DELETE",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ path: started.outputPath }),
        });
      expect((await remove({ [AGENT_HEADER]: "native" })).ok).toBe(false);
      expect(await readdir(directory)).toEqual(["Delivery.webm"]);
      expect((await remove({})).ok).toBe(true);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      await editor.dispose();
      await f.close();
    }
  },
  90_000,
);
