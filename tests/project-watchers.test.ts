import { expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileContentVersion } from "@hyperframes/studio-server";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { projectFixture } from "./project-fixture";

async function watches() {
  let count = 0;
  for (const fd of await readdir("/proc/self/fdinfo")) {
    const info = await readFile(`/proc/self/fdinfo/${fd}`, "utf8").catch(
      () => "",
    );
    count += info.split("inotify wd:").length - 1;
  }
  return count;
}

test.skipIf(process.platform !== "linux")(
  "listing and resolving closed projects keeps no watches; editor subscriptions share and release them",
  async () => {
    const f = await projectFixture();
    const api = createHyperframesApi(f.store, f.review);
    try {
      const projects = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          f.store.create({ name: `Watch ${i}` }),
        ),
      );
      const before = await watches();
      await api.request("/projects");
      for (const project of projects)
        await api.request(`/projects/${project.id}`);
      expect(await watches()).toBe(before);
      const project = projects[0]!;
      const seen: string[] = [];
      const stop = await api.subscribe(project.id, (change) => {
        seen.push(change.path);
      });
      const open = await watches();
      expect(open).toBeGreaterThan(before);
      const stopOther = await api.subscribe(project.id, () => {});
      expect(await watches()).toBe(open);
      stop();
      expect(await watches()).toBe(open);
      await writeFile(
        `${project.path}/index.html`,
        "closed after the last tab",
      );
      await Bun.sleep(150);
      expect(seen).toEqual([]);
      stopOther();
      expect(await watches()).toBe(before);
    } finally {
      await api.dispose();
      await f.close();
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "the editor's own writes and undos reach the preview at once and only once; outside writes still settle first",
  async () => {
    const f = await projectFixture();
    const api = createHyperframesApi(f.store, f.review);
    try {
      const project = await f.store.create({ name: "Own writes" });
      const path = join(project.path, "index.html");
      const changes: { version: string | null; at: number }[] = [];
      const stop = await api.subscribe(project.id, (change) => {
        if (change.path === "index.html")
          changes.push({ version: change.version, at: performance.now() });
      });
      const seen = async (count: number, since: number) => {
        // Long enough for the watcher's 60 ms settle to announce anything it still holds.
        await Bun.sleep(300);
        expect(changes.map(({ version }) => version)).toHaveLength(count);
        return changes.at(-1)!.at - since;
      };
      const before = await readFile(path, "utf8");
      const after = before.replace("</body>", "<p>own</p></body>");
      let start = performance.now();
      await f.store.mutate(project, "Own write", async () =>
        f.store.writeFiles(project, [
          { sourceFile: "index.html", absPath: path, before, after },
        ]),
      );
      const own = await seen(1, start);
      expect(changes[0]!.version).toBe(fileContentVersion(after));

      start = performance.now();
      const undo = await f.request(
        `/projects/${project.id}/history/undo`,
        "POST",
      );
      expect(undo.status).toBe(200);
      const undone = await seen(2, start);
      expect(changes[1]!.version).toBe(fileContentVersion(before));

      start = performance.now();
      await writeFile(path, before.replace("</body>", "<p>outside</p></body>"));
      const outside = await seen(3, start);
      // Own writes skip the 60 ms wait that outside editors get.
      expect(own).toBeLessThan(60);
      expect(undone).toBeLessThan(60);
      expect(outside).toBeGreaterThanOrEqual(60);
      stop();
    } finally {
      await api.dispose();
      await f.close();
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "an outside write right after an editor write is the last change the preview hears",
  async () => {
    const f = await projectFixture();
    // Hold the first announcement in review bookkeeping, so it is still pending when the
    // outside write lands.
    let hold = false;
    const observeAssets = f.review.observeAssets.bind(f.review);
    const review = Object.assign(Object.create(f.review), {
      observeAssets: async (...args: Parameters<typeof observeAssets>) => {
        if (hold) {
          hold = false;
          await Bun.sleep(250);
        }
        return observeAssets(...args);
      },
    });
    const api = createHyperframesApi(f.store, review);
    try {
      const project = await f.store.create({ name: "Ordered writes" });
      const path = join(project.path, "index.html");
      const versions: (string | null)[] = [];
      const stop = await api.subscribe(project.id, (change) => {
        if (change.path === "index.html") versions.push(change.version);
      });
      const before = await readFile(path, "utf8");
      const own = before.replace("</body>", "<p>own</p></body>");
      hold = true;
      await f.store.mutate(project, "Own write", async () =>
        f.store.writeFiles(project, [
          { sourceFile: "index.html", absPath: path, before, after: own },
        ]),
      );
      const outside = before.replace("</body>", "<p>outside</p></body>");
      await writeFile(path, outside);
      await Bun.sleep(600);
      expect(versions.at(-1)).toBe(fileContentVersion(outside));
      stop();
    } finally {
      await api.dispose();
      await f.close();
    }
  },
);
