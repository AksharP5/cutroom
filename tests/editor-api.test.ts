import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createReviewService } from "../src/server/projects/review";
import { createProjectStore } from "../src/server/projects/store";
import { addStarterClips } from "./starter-clips";

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
  await addStarterClips(project);
  const api = createHyperframesApi(store, createReviewService(store));
  cleanups.push(() => api.dispose());
  return { store, project, api };
}

describe("HyperFrames editor integration", () => {
  test("serves real project files, self-hosted runtime, and a seekable preview", async () => {
    const { api, project } = await setup();
    // The HyperFrames CLI finds Cutroom's server through this list when agents read the selection.
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
    // Opened by URL on Cutroom's own origin, composition scripts must not run.
    expect(preview.headers.get("content-security-policy")).toBe("sandbox");
    const html = await preview.text();
    expect(html).toContain("Geometry test");
    expect(html).toContain("/api/runtime.js");
    expect(html).toContain("data-composition-id");
    expect((await api.request("/projects/does-not-exist")).status).toBe(404);
    const gsap = await api.request("/vendor/npm/gsap@3.15.0/dist/gsap.min.js");
    expect(gsap.status).toBe(200);
    expect(await gsap.text()).toContain("gsap");
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
