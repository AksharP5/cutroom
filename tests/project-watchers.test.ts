import { expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
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
