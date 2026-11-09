import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileContentVersion } from "@hyperframes/studio-server";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createProjectStore } from "../src/server/projects/store";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cutroom-editor-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const store = await createProjectStore({ dataDir: dir });
  cleanups.push(() => store.close());
  const project = await store.create({
    name: "Geometry test",
    width: 320,
    height: 240,
    duration: 2,
  });
  const api = createHyperframesApi(store);
  cleanups.push(() => api.dispose());
  return { store, project, api };
}

describe("HyperFrames editor integration", () => {
  test("serves real project files, self-hosted runtime, and a seekable preview", async () => {
    const { api, project } = await setup();
    const listed = await api.request("/projects");
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain(project.id);
    const resolved = await api.request(`/projects/${project.id}`);
    expect(await resolved.text()).toContain('"index.html"');
    const runtime = await api.request("/runtime.js");
    expect(runtime.headers.get("content-type")).toContain("javascript");
    expect((await runtime.text()).length).toBeGreaterThan(10_000);
    const preview = await api.request(`/projects/${project.id}/preview`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("Geometry test");
    expect(html).toContain("/api/runtime.js");
    expect(html).toContain("data-composition-id");
    expect((await api.request("/projects/does-not-exist")).status).toBe(404);
    const gsap = await api.request("/vendor/npm/gsap@3.15.0/dist/gsap.min.js");
    expect(gsap.status).toBe(200);
    expect(await gsap.text()).toContain("gsap");
  });

  test("canvas mutations share project history, undo restores source, and stale writes conflict", async () => {
    const { api, project, store } = await setup();
    const source = join(project.path, "index.html");
    const original = await readFile(source, "utf8");
    const window = await (
      await store.history(project)
    ).beginWindow({ kind: "person", name: "You" }, "Set headline color");
    const patch = await api.request(
      `/projects/${project.id}/file-mutations/patch-element/index.html`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "if-match": fileContentVersion(original),
        },
        body: JSON.stringify({
          target: { id: "headline" },
          operations: [
            {
              type: "inline-style",
              property: "color",
              value: "rgb(255, 0, 0)",
            },
          ],
        }),
      },
    );
    expect(patch.status).toBe(200);
    const edited = await readFile(source, "utf8");
    expect(edited).toContain("rgb(255, 0, 0)");
    await window.close();
    const stale = await api.request(
      `/projects/${project.id}/files/index.html`,
      {
        method: "PUT",
        headers: {
          "content-type": "text/plain",
          "if-match": fileContentVersion(original),
        },
        body: original,
      },
    );
    expect(stale.status).toBe(409);
    expect(await readFile(source, "utf8")).toBe(edited);
    const undo = await api.request(`/projects/${project.id}/history/step`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "back" }),
    });
    expect(undo.status).toBe(200);
    expect(await readFile(source, "utf8")).toBe(original);
  });

  test("an outside file edit invalidates the cached preview", async () => {
    const { api, project } = await setup();
    const url = `/projects/${project.id}/preview`;
    const first = await api.request(url);
    const firstTag = first.headers.get("etag");
    await first.text();
    const source = join(project.path, "index.html");
    await writeFile(
      source,
      (await readFile(source, "utf8")).replace(
        "Geometry test",
        "Updated outside the editor",
      ),
    );
    await new Promise<void>((done) => setTimeout(done, 180));
    const next = await api.request(url, {
      headers: firstTag ? { "if-none-match": firstTag } : undefined,
    });
    expect(next.status).toBe(200);
    expect(await next.text()).toContain("Updated outside the editor");
  });
});
