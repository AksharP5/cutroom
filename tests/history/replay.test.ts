import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectHistory } from "../../src/server/history/projectHistory";
import type {
  ProjectHistory,
  ProjectHistoryOptions,
} from "../../src/server/history/projectHistory";
import type { HistoryEntry } from "../../src/server/history/historyLog";

const owner = { kind: "person", name: "You", key: "owner" } as const;
const agent = { kind: "agent", name: "Codex", key: "session:agent" } as const;
let scratch: string;
let projectDir: string;
let historyRoot: string;
let history: ProjectHistory | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "cutroom-history-replay-"));
  projectDir = join(scratch, "project");
  historyRoot = join(scratch, "history");
  await mkdir(projectDir);
  await write("a.css", "before a");
  await write("b.css", "before b");
});

afterEach(async () => {
  await history?.close();
  history = undefined;
  await rm(scratch, { force: true, recursive: true });
});

const write = (path: string, contents: string) =>
  writeFile(join(projectDir, path), contents);
const read = (path: string) => readFile(join(projectDir, path), "utf8");
const open = async (options: Partial<ProjectHistoryOptions> = {}) =>
  (history = await openProjectHistory({ projectDir, historyRoot, ...options }));
const record = async (
  ledger: ProjectHistory,
  who: typeof owner | typeof agent,
  label: string,
  edits: Record<string, string>,
) => {
  const window = await ledger.beginWindow(who, label);
  for (const [path, text] of Object.entries(edits)) await write(path, text);
  const entry = await window.close();
  if (!entry) throw new Error("The fixture edit was not recorded.");
  return entry;
};
const inverse = (
  entry: HistoryEntry,
  replay: "group" | "ordinary" = "ordinary",
) => ({
  id: entry.id,
  replay,
  files: entry.files.map(({ path, before, after }) => ({
    path,
    before: after,
    after: before,
  })),
});

test("a partial replay rolls back its own writes and preserves a later outside edit", async () => {
  const ledger = await open();
  const entry = await record(ledger, owner, "Edit both", {
    "a.css": "edited a",
    "b.css": "edited b",
  });
  const home = join(historyRoot, ledger.projectId);
  await ledger.close();
  const pending = join(home, "pending-replay.json");
  const log = join(home, "log.jsonl");
  await appendFile(log, '{"type":"entry"');
  await write("a.css", "before a");
  await write("b.css", "outside b");
  await writeFile(
    pending,
    JSON.stringify({ id: "crashed", files: inverse(entry).files }),
  );
  // The crash cut off a write before its rename.
  await write("a.css.hf0a1b2c.tmp", "half written");
  await write("a.css.notes", "kept");

  const warnings: string[] = [];
  const reopened = await open({
    onError: (error) => warnings.push(String(error)),
  });
  expect(await read("a.css")).toBe("edited a");
  expect(await read("b.css")).toBe("outside b");
  expect(warnings).toEqual([
    "Error: Skipped history recovery for b.css: It changed outside Cutroom.",
  ]);
  expect(await Bun.file(pending).exists()).toBe(false);
  expect(await Bun.file(join(projectDir, "a.css.hf0a1b2c.tmp")).exists()).toBe(
    false,
  );
  expect(await read("a.css.notes")).toBe("kept");
  const raw = await readFile(log, "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  for (const line of raw.trimEnd().split("\n"))
    expect(() => JSON.parse(line)).not.toThrow();
  expect(
    reopened.list().map(({ id, who }) => ({ id, kind: who.kind })),
  ).toEqual([
    { id: entry.id, kind: "person" },
    expect.objectContaining({ kind: "outside" }),
  ]);
});

test("a grouped replay keeps a separate committed entry for each undo across restart", async () => {
  const ledger = await open();
  const own = await record(ledger, owner, "Owner edit", {
    "a.css": "edited a",
  });
  const dependent = await record(ledger, agent, "Dependent edit", {
    "b.css": "edited b",
  });
  const last = await ledger.revert(
    owner,
    () => ({
      steps: [inverse(dependent, "group"), inverse(own, "group")],
      blobs: new Map(),
    }),
    { requestId: "both" },
  );
  if (!last.ok || !last.entry) throw new Error("The replay did not commit.");
  const home = join(historyRoot, ledger.projectId);
  const pending = join(home, "pending-replay.json");
  expect(await Bun.file(pending).exists()).toBe(false);
  await ledger.close();
  // A crash after the log replacement can leave an already committed journal.
  await writeFile(
    pending,
    JSON.stringify({
      id: last.entry.id,
      files: [...inverse(dependent).files, ...inverse(own).files],
    }),
  );

  const reopened = await open();
  expect(await read("a.css")).toBe("before a");
  expect(await read("b.css")).toBe("before b");
  expect(await Bun.file(pending).exists()).toBe(false);
  expect(
    reopened
      .list()
      .slice(-2)
      .map(({ undoes }) => undoes),
  ).toEqual([dependent.id, own.id]);
  const repeated = await reopened.revert(
    owner,
    () => {
      throw new Error("A committed request should not be planned again.");
    },
    { requestId: "both" },
  );
  expect(repeated).toMatchObject({
    ok: true,
    repeated: true,
    entry: { id: last.entry.id },
  });
});

test("a new outside write during replay rolls back published files and keeps the outside bytes", async () => {
  const ledger = await open({
    beforeReplay: async () => {
      await write("b.css", "outside b");
    },
  });
  const entry = await record(ledger, owner, "Edit both", {
    "a.css": "edited a",
    "b.css": "edited b",
  });
  await expect(
    ledger.revert(
      owner,
      () => ({
        steps: [inverse(entry)],
        blobs: new Map(),
      }),
      {},
    ),
  ).rejects.toThrow("b.css changed during history replay.");
  expect(await read("a.css")).toBe("edited a");
  expect(await read("b.css")).toBe("outside b");
  await ledger.checkpoint();
  expect(ledger.list().every(({ undoes }) => !undoes)).toBe(true);
  expect(ledger.list().at(-1)?.who.kind).toBe("outside");
  expect(
    await Bun.file(
      join(historyRoot, ledger.projectId, "pending-replay.json"),
    ).exists(),
  ).toBe(false);
});
