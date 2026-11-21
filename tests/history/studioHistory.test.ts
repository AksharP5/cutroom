import { afterEach, expect, test } from "bun:test";
import {
  createStudioApi,
  fileContentVersion,
  identifyFileWrite,
  openProjectHistory as openUpstreamHistory,
} from "@hyperframes/studio-server";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openProjectHistory,
  readProjectHistory,
} from "../../src/server/history/projectHistory";

const who = { kind: "person", name: "You" } as const;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cutroom-studio-history-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const historyRoot = join(root, "history");
  const source = join(projectDir, "index.html");
  await mkdir(projectDir);
  await writeFile(source, "initial");
  return { projectDir, historyRoot, source, pruneGoneProjectsBudgetMs: 0 };
}

test("Studio route writes inside an owned history window keep the replaced bytes and replay receipt", async () => {
  const options = await fixture();
  const history = await openProjectHistory(options);
  cleanups.push(history.close);
  const project = { id: "cut", title: "Cut", dir: options.projectDir };
  const api = createStudioApi({
    listProjects: () => [project],
    resolveProject: () => project,
    history: () => history,
    bundle: async () => null,
    lint: () => ({ findings: [] }),
    runtimeUrl: "/runtime.js",
    rendersDir: () => options.historyRoot,
    startRender: () => {
      throw new Error("This fixture only exercises history and file routes.");
    },
  });
  const window = await history.beginWindow(who, "Edit title");
  for (const [previous, next] of [
    ["initial", "intermediate"],
    ["intermediate", "edited"],
  ]) {
    const saved = await api.request("/projects/cut/files/index.html", {
      method: "PUT",
      headers: {
        "If-Match": fileContentVersion(previous),
        "X-Hyperframes-Write-Token": `save-${next}`,
      },
      body: next,
    });
    expect(saved.status).toBe(200);
  }
  const entry = await window.close();
  expect(entry?.files).toHaveLength(1);
  const before = entry?.files[0]?.before;
  if (!before) throw new Error("The history entry has no previous source.");
  expect(await history.readBlob(before)).toEqual(Buffer.from("initial"));
  // Neither window sweep saw the intermediate state, so only Studio's write receipt can save it.
  const intermediate = createHash("sha256")
    .update("intermediate")
    .digest("hex");
  expect(await history.readBlob(intermediate)).toEqual(
    Buffer.from("intermediate"),
  );

  const undone = await api.request("/projects/cut/history/step", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hyperframes-Write-Token": "undo-title",
    },
    body: JSON.stringify({ direction: "back" }),
  });
  expect(undone.status).toBe(200);
  expect(await readFile(options.source, "utf8")).toBe("initial");
  expect(
    identifyFileWrite(options.source, fileContentVersion("initial")),
  ).toEqual({
    path: "index.html",
    version: fileContentVersion("initial"),
    writeToken: "undo-title",
  });
});

test("the owned engine opens an upstream 0.9.26 log without rewriting it", async () => {
  const options = await fixture();
  const upstream = await openUpstreamHistory(options);
  cleanups.push(upstream.close);
  const window = await upstream.beginWindow(who, "Edit title");
  await writeFile(options.source, "edited");
  const entry = await window.close();
  if (!entry?.files[0]?.before)
    throw new Error("The upstream log has no previous source.");
  const before = entry.files[0].before;
  upstream.pin(entry.id, true);
  const expected = upstream.list();
  await upstream.close();

  const log = join(options.historyRoot, upstream.projectId, "log.jsonl");
  const original = await readFile(log);
  expect(readProjectHistory(options).list()).toEqual(expected);
  const owned = await openProjectHistory(options);
  cleanups.push(owned.close);
  expect(owned.list()).toEqual(expected);
  expect(await owned.readBlob(before)).toEqual(Buffer.from("initial"));
  await owned.close();
  expect(await readFile(log)).toEqual(original);
});
