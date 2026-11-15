import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
