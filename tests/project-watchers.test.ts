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
  "resolving closed projects keeps no watches; editor subscriptions share and release them",
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
    let settleIndex: (() => Promise<void>) | undefined;
    let scheduled = Promise.withResolvers<void>();
    const api = createHyperframesApi(
      f.store,
      f.review,
      undefined,
      (path, read) => {
        if (path === "index.html") {
          settleIndex = read;
          scheduled.resolve();
        }
        return () => {
          if (settleIndex === read) settleIndex = undefined;
        };
      },
    );
    try {
      const project = await f.store.create({ name: "Own writes" });
      const path = join(project.path, "index.html");
      const versions: (string | null)[] = [];
      let announced = Promise.withResolvers<void>();
      const stop = await api.subscribe(project.id, (change) => {
        if (change.path !== "index.html") return;
        versions.push(change.version);
        announced.resolve();
      });
      const flush = async () => {
        await scheduled.promise;
        const read = settleIndex!;
        settleIndex = undefined;
        scheduled = Promise.withResolvers<void>();
        await read();
      };
      const before = await readFile(path, "utf8");
      const after = before.replace("</body>", "<p>own</p></body>");
      await f.store.mutate(project, "Own write", async () =>
        f.store.writeFiles(project, [
          { sourceFile: "index.html", absPath: path, before, after },
        ]),
      );
      // Both editor events must arrive while the settled read is still held.
      await announced.promise;
      await flush();
      expect(versions).toEqual([fileContentVersion(after)]);

      announced = Promise.withResolvers<void>();
      const undo = await f.request(
        `/projects/${project.id}/history/undo`,
        "POST",
      );
      expect(undo.status).toBe(200);
      await announced.promise;
      await flush();
      expect(versions).toEqual([
        fileContentVersion(after),
        fileContentVersion(before),
      ]);

      const outside = before.replace("</body>", "<p>outside</p></body>");
      await writeFile(path, outside);
      await scheduled.promise;
      // Let the immediate read see the outside write while the settled read is held.
      await Bun.sleep(300);
      expect(versions).toHaveLength(2);
      await flush();
      expect(versions).toEqual([
        fileContentVersion(after),
        fileContentVersion(before),
        fileContentVersion(outside),
      ]);
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
