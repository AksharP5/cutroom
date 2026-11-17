import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as hyperframes from "@hyperframes/studio-server";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createProjectStore } from "../src/server/projects/store";
import { createReviewService } from "../src/server/projects/review";

const composition = (color: string) =>
  `<html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="4"><div id="fill" class="clip" data-start="0" data-duration="4" style="background:${color}">${color}</div></main></body></html>`;

test.each([
  ["preview", "index.html", ""],
  ["sub-composition preview", "scene.html", "/comp/scene.html"],
])(
  "a %s compiled while its source changed is never revalidated as the signed version",
  async (_name, file, route) => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-preview-validator-"));
    const store = await createProjectStore({
      dataDir: root,
      projectsDir: join(root, "projects"),
    });
    const editor = createHyperframesApi(store, createReviewService(store));
    const app = new Hono().route("/api", editor);
    let afterSignature: (() => Promise<void>) | null = null;
    const signature = hyperframes.createProjectSignatureAsync;
    const spy = spyOn(
      hyperframes,
      "createProjectSignatureAsync",
    ).mockImplementation(async (...args) => {
      const result = await signature(...args);
      const hook = afterSignature;
      afterSignature = null;
      await hook?.();
      return result;
    });
    try {
      const project = await store.create({
        name: "Validators",
        width: 320,
        height: 240,
        duration: 4,
      });
      const source = join(project.path, file);
      await writeFile(source, composition("green"));
      const url = `/api/projects/${project.id}/preview${route}`;
      // The route signs green, then an edit lands before the compiler reads the file.
      afterSignature = () => writeFile(source, composition("blue"));
      const raced = await app.request(url);
      expect(await raced.text()).toContain("background:blue");

      // Undo restores green. A browser revalidating the raced body must not keep blue.
      await writeFile(source, composition("green"));
      const validator = raced.headers.get("ETag");
      const revalidated = await app.request(url, {
        headers: validator ? { "If-None-Match": validator } : {},
      });
      expect(revalidated.status).toBe(200);
      expect(await revalidated.text()).toContain("background:green");
    } finally {
      spy.mockRestore();
      await editor.dispose();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("raw nested previews preserve source bytes and revalidate against image defaults", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "cutroom-preview-image-validator-"),
  );
  const store = await createProjectStore({
    dataDir: root,
    projectsDir: join(root, "projects"),
  });
  const editor = createHyperframesApi(store, createReviewService(store));
  const app = new Hono().route("/api", editor);
  try {
    const project = await store.create({ name: "Image validators" });
    const directory = join(project.path, "compositions");
    await mkdir(directory, { recursive: true });
    const bytes = Buffer.from("\uFEFF<p>Artwork</p>");
    const scene = `<main data-composition-id="scene" data-composition-variables='[{"id":"art","type":"image","label":"Artwork","default":"art.svg"}]'>Artwork</main>`;
    await writeFile(join(directory, "plain.html"), bytes);
    await writeFile(join(directory, "scene.htm"), scene);
    const preview = `/api/projects/${project.id}/preview/compositions`;

    const plain = await app.request(`${preview}/plain.html`);
    expect(plain.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(Buffer.from(await plain.arrayBuffer())).toEqual(bytes);

    // Studio emits source validators for .htm once the file has settled.
    await Bun.sleep(3_100);
    const url = `${preview}/scene.htm`;
    const initial = await app.request(url);
    const validator = initial.headers.get("ETag");
    if (!validator) throw new Error("Expected a settled source validator.");
    expect(await initial.text()).toBe(scene);
    const headers = { "If-None-Match": validator };
    const unchanged = await app.request(url, { headers });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("ETag")).toBe(validator);
    expect(unchanged.headers.get("Content-Length")).toBeNull();

    await writeFile(join(directory, "art.svg"), "<svg/>");
    const changed = await app.request(url, { headers });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe(
      scene.replace('"default":"art.svg"', '"default":"compositions/art.svg"'),
    );
    expect(changed.headers.get("Cache-Control")).toBe("no-store");
    expect(changed.headers.get("ETag")).toBeNull();
    expect(changed.headers.get("Content-Length")).toBeNull();
    expect(changed.headers.get("Accept-Ranges")).toBeNull();

    const partial = await app.request(url, {
      headers: { Range: "bytes=0-9" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe(
      `bytes 0-9/${scene.length}`,
    );
    expect(await partial.text()).toBe(scene.slice(0, 10));
  } finally {
    await editor.dispose();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
