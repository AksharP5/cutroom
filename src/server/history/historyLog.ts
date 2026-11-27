// Copyright 2026 HeyGen, Inc.
// SPDX-License-Identifier: Apache-2.0
// From heygen-com/hyperframes v0.9.26, packages/studio-server/src/history/historyLog.ts.
// Modified by Cutroom. See THIRD_PARTY_NOTICES.md.

import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { replaceFileAtomically } from "@hyperframes/core/atomic-file";

export class HistoryLogReadError extends Error {}

export interface HistoryWho {
  kind: "person" | "agent" | "outside";
  /** Shown in the History list: "You", the agent's name, "Outside". */
  name: string;
  /** Stable identity for this editor, independent of the display name. */
  key?: string;
}

/** A file's sha256 before and after; null is "did not exist", so a create or delete undoes like any edit. */
export interface HistoryFileChange {
  path: string;
  before: string | null;
  after: string | null;
}

export type HistoryEntrySide = "before" | "after";

export interface HistoryTarget {
  file: string;
  id?: string;
  hfId?: string;
  selector?: string;
  selectorIndex?: number;
}

export interface HistoryEntry {
  targets?: HistoryTarget[];
  id: string;
  who: HistoryWho;
  label: string;
  startedAt: number;
  endedAt: number;
  files: HistoryFileChange[];
  /** Set on an undo: the entry it reverted. Redo is undoing the undo. */
  undoes?: string;
  replay?: "ordinary" | "explicit" | "group";
  /** `timeline`: a timeline duplicated, created or renamed, related only to later edits of its files. */
  category?: "marker" | "media" | "text" | "import" | "timeline" | "library";
  requestId?: string;
  incomplete?: true;
  /** Set on a restore: the point (an entry id, or START) the files were made equal to. */
  restoredTo?: string;
}

/** The point before the first kept entry. */
export const START = "start";

/** Path to hash. */
export type Manifest = Map<string, string>;

export interface HistoryLog {
  baseline: Manifest;
  entries: HistoryEntry[];
  pins: Set<string>;
  keepsLedger?: boolean;
  unterminated?: true;
  damagedSource?: Buffer;
}

export type LogRecord =
  | { type: "baseline"; files: Record<string, string>; keepsLedger?: boolean }
  | { type: "entry"; entry: HistoryEntry }
  | { type: "pin"; id: string; pinned: boolean };

function parseRecord(line: string): LogRecord | null {
  try {
    const record: LogRecord | null = JSON.parse(line);
    if (record?.type === "baseline") return record;
    if (record?.type === "entry" && Array.isArray(record.entry?.files))
      return record;
    if (
      record?.type === "pin" &&
      typeof record.id === "string" &&
      typeof record.pinned === "boolean"
    )
      return record;
    return null;
  } catch {
    return null;
  }
}

/** Untouched bytes are retained if a later rewrite would omit a damaged record. */
export function readLog(
  file: string,
  onUnreadable: (line: number) => void,
): HistoryLog | null {
  let source: Buffer;
  try {
    source = readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const detail = error instanceof Error ? error.message : String(error);
    throw new HistoryLogReadError(
      `Could not read the project history log: ${detail}`,
      {
        cause: error,
      },
    );
  }
  const log: HistoryLog = { baseline: new Map(), entries: [], pins: new Set() };
  const lines = source.toString("utf8").split("\n");
  let hasBaseline = false;
  const brokenBaseline = () =>
    new HistoryLogReadError(
      `The project history log has a damaged baseline: ${file}`,
    );
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const record = parseRecord(line);
    if (!hasBaseline && record?.type !== "baseline") throw brokenBaseline();
    const atEnd = index === lines.length - 1;
    if (atEnd) log.unterminated = true;
    if (!record) {
      log.damagedSource = source;
      if (!atEnd) onUnreadable(index + 1);
      continue;
    }
    if (record.type === "baseline") {
      if (
        !record.files ||
        typeof record.files !== "object" ||
        Array.isArray(record.files) ||
        Object.values(record.files).some((hash) => typeof hash !== "string")
      )
        throw brokenBaseline();
      hasBaseline = true;
    }
    applyRecord(log, record);
  }
  if (!hasBaseline) throw brokenBaseline();
  return log;
}

function applyRecord(log: HistoryLog, record: LogRecord): void {
  if (record.type === "baseline") {
    log.baseline = new Map(Object.entries(record.files));
    log.keepsLedger = record.keepsLedger === true;
  } else if (record.type === "entry") log.entries.push(record.entry);
  else if (record.pinned) log.pins.add(record.id);
  else log.pins.delete(record.id);
}

/** Appends `record`, already applied to `log`; a log file that is gone is written whole, so a restart replays it. */
export function saveRecord(
  file: string,
  log: HistoryLog,
  record: LogRecord,
): void {
  let fd: number;
  try {
    // No O_CREAT: an append never creates a log that would lack its baseline.
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return writeLog(file, log);
  }
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
}

export function baselineRecord(log: HistoryLog): LogRecord {
  return {
    type: "baseline",
    files: Object.fromEntries(log.baseline),
    ...(log.keepsLedger && { keepsLedger: true }),
  };
}

export function writeLog(file: string, log: HistoryLog): void {
  const records: LogRecord[] = [
    baselineRecord(log),
    ...log.entries.map((entry) => ({ type: "entry" as const, entry })),
    ...[...log.pins].map((id) => ({ type: "pin" as const, id, pinned: true })),
  ];
  mkdirSync(dirname(file), { recursive: true });
  if (log.damagedSource) {
    let source = log.damagedSource;
    try {
      source = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    replaceFileAtomically(`${file}.damaged-${randomUUID()}`, source, 0o600);
  }
  replaceFileAtomically(
    file,
    records.map((r) => `${JSON.stringify(r)}\n`).join(""),
    0o644,
  );
  delete log.damagedSource;
}

function applyEntry(
  manifest: Manifest,
  entry: HistoryEntry,
  side: HistoryEntrySide,
): void {
  for (const file of entry.files) {
    const hash = file[side];
    if (hash === null) manifest.delete(file.path);
    else manifest.set(file.path, hash);
  }
}

/** The files as they were right after `point`. Null when that point is no longer kept. */
export function manifestAt(log: HistoryLog, point: string): Manifest | null {
  return point === START
    ? new Map(log.baseline)
    : manifestAround(log, point, "after");
}

/** Entry `id`'s own files as it found (`before`) or left (`after`) them; the rest as earlier entries left them. */
export function manifestAround(
  log: HistoryLog,
  id: string,
  side: HistoryEntrySide,
): Manifest | null {
  const manifest = new Map(log.baseline);
  for (const entry of log.entries) {
    applyEntry(manifest, entry, entry.id === id ? side : "after");
    if (entry.id === id) return manifest;
  }
  return null;
}

/** Entries currently reverted: an undo that is itself in effect reverts its target. */
export function undoneIds(entries: readonly HistoryEntry[]): Set<string> {
  const undone = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.undoes && !undone.has(entry.id)) undone.add(entry.undoes);
  }
  return undone;
}

/**
 * What Cmd+Z (back) or Cmd+Shift+Z (forward) reverts for `mine`. Back: the newest change `mine` owns that is still
 * in effect. Forward: the newest of `mine`'s undos still in effect, while `mine` has made no change since.
 */
export function stepTarget(
  entries: readonly HistoryEntry[],
  direction: "back" | "forward",
  mine: (entry: HistoryEntry) => boolean,
): HistoryEntry | undefined {
  const undone = undoneIds(entries);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const owns = ownerOf(entries, byId, mine);
  const newestFirst = [...entries].reverse();
  if (direction === "back")
    return newestFirst.find(
      (entry) => !entry.undoes && !undone.has(entry.id) && owns(entry),
    );
  for (const entry of newestFirst) {
    if (!entry.undoes) {
      if (owns(entry)) return undefined;
      continue;
    }
    const target = byId.get(entry.undoes);
    if (mine(entry) && !undone.has(entry.id) && target && !target.undoes)
      return entry;
  }
  return undefined;
}

/** A change is yours to step over if you made it, or your redo is what brought it back. */
function ownerOf(
  entries: readonly HistoryEntry[],
  byId: ReadonlyMap<string, HistoryEntry>,
  mine: (entry: HistoryEntry) => boolean,
): (entry: HistoryEntry) => boolean {
  const redoneBy = new Map<string, HistoryEntry>();
  for (const entry of entries) {
    const target = entry.undoes ? byId.get(entry.undoes) : undefined;
    if (target?.undoes) redoneBy.set(target.undoes, entry);
  }
  return (entry) => mine(entry) || mine(redoneBy.get(entry.id) ?? entry);
}

/**
 * Folds the oldest entry into the baseline unless it is pinned. ponytail: an old pin therefore holds everything
 * after it; per-point snapshots would lift that. Returns whether one was folded.
 */
export function foldOldest(log: HistoryLog): boolean {
  const oldest = log.entries[0];
  if (!oldest || log.pins.has(oldest.id)) return false;
  applyEntry(log.baseline, oldest, "after");
  log.entries.shift();
  return true;
}

/** Every hash a kept point can still need. */
export function referencedHashes(
  log: HistoryLog,
  current: Manifest,
): Set<string> {
  const keep = new Set([...log.baseline.values(), ...current.values()]);
  for (const entry of log.entries)
    for (const file of entry.files) {
      if (file.before) keep.add(file.before);
      if (file.after) keep.add(file.after);
    }
  return keep;
}
