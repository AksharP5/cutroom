// Copyright 2026 HeyGen, Inc.
// SPDX-License-Identifier: Apache-2.0
// From heygen-com/hyperframes v0.9.26, packages/studio-server/src/history/videoState.ts.
// Modified by Cutroom. See THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { replaceFileAtomically } from "@hyperframes/core/atomic-file";
import { pinProjectRecord } from "@hyperframes/studio-server/safe-path";
import { takeHistoryOwnership } from "./ownerLock.js";
import type { HistoryEntry, HistoryWho, HistoryTarget } from "./historyLog.js";

export interface FileVersion {
  hash: string;
  content: string;
}

export interface RevisionState {
  targets?: HistoryTarget[];
  actor: HistoryWho;
  label: string;
  startedAt: number;
  endedAt: number;
  undoes?: string;
  restoredTo?: string;
  files: Record<string, { before: string | null; after: string | null }>;
}

export interface ArtifactInput {
  kind: "check" | "snapshot";
  id: string;
  scope: string;
  report?: string;
  image?: string;
  time?: number;
  metadata?: Record<string, unknown>;
}

export interface ArtifactRecord extends Omit<ArtifactInput, "kind"> {
  status?: "cleaned";
  cleanedAfterRender?: string;
  createdAt: number;
  contentHash: string;
  revision: string | null;
  inputFingerprint: string;
  inputScope: "local-project-files";
  attribution: "recorded-revision" | "unversioned" | "inputs-changed";
}

interface ArtifactCollection {
  latest: { revision: string | null; id: string } | null;
  revisions: Record<string, ArtifactRecord[]>;
  unversioned: ArtifactRecord[];
}

export interface RenderRecord {
  revision?: string | null;
  id: string;
  completedAt: number;
  output: string;
  status: "completed" | "completed_with_warnings";
}

export interface VideoState {
  version: 1;
  historyId: string | null;
  currentRevision: string | null;
  pendingChanges: boolean;
  files: Record<string, FileVersion>;
  revisions: Record<string, RevisionState>;
  checks: ArtifactCollection;
  snapshots: ArtifactCollection;
  renders?: { latest: RenderRecord | null; retainedRevisions?: string[] };
}

function statePath(dir: string): string {
  const path = pinProjectRecord(dir, ".hyperframes/video-state.json");
  if (!path) throw new Error("Video state must stay inside the project.");
  return path;
}
const collection = (): ArtifactCollection => ({
  latest: null,
  revisions: {},
  unversioned: [],
});
const emptyState = (): VideoState => ({
  version: 1,
  historyId: null,
  currentRevision: null,
  pendingChanges: true,
  files: {},
  revisions: {},
  checks: collection(),
  snapshots: collection(),
});

function readState(dir: string): VideoState {
  if (!existsSync(statePath(dir))) return emptyState();
  const state: VideoState = JSON.parse(readFileSync(statePath(dir), "utf8"));
  if (
    state.version !== 1 ||
    !state.checks ||
    !state.snapshots ||
    !state.revisions ||
    !state.files
  )
    throw new Error("Unsupported video-state schema.");
  return state;
}

async function updateState(
  dir: string,
  update: (state: VideoState) => boolean,
): Promise<void> {
  const lock = pinProjectRecord(dir, ".hyperframes/video-state-lock");
  if (!lock) throw new Error("Video state lock must stay inside the project.");
  const release = await takeHistoryOwnership(lock, 5000);
  try {
    let state: VideoState;
    try {
      state = readState(dir);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      renameSync(statePath(dir), `${statePath(dir)}.invalid-${randomUUID()}`);
      state = emptyState();
    }
    if (!update(state)) return;
    replaceFileAtomically(
      statePath(dir),
      JSON.stringify(state, null, 2) + "\n",
      0o644,
    );
  } finally {
    release();
  }
}

export async function writeHistoryState(
  projectDir: string,
  historyId: string,
  historyDirectory: string,
  entries: readonly HistoryEntry[],
  currentFiles: ReadonlyMap<string, string>,
  committedFiles: ReadonlyMap<string, string>,
): Promise<void> {
  const blob = (hash: string | null) =>
    hash === null
      ? null
      : resolve(historyDirectory, "blobs", hash.slice(0, 2), hash);
  await updateState(projectDir, (state) => {
    const currentRevision = entries.at(-1)?.id ?? null;
    const pendingChanges =
      currentFiles.size !== committedFiles.size ||
      [...currentFiles].some(
        ([path, hash]) => committedFiles.get(path) !== hash,
      );
    const files = Object.fromEntries(
      [...currentFiles].map(([path, hash]) => [
        path,
        { hash, content: blob(hash)! },
      ]),
    );
    const revisions = Object.fromEntries(
      entries.map((entry) => [entry.id, revisionState(entry, blob)]),
    );
    const changed =
      state.historyId !== historyId ||
      state.currentRevision !== currentRevision ||
      state.pendingChanges !== pendingChanges ||
      !Bun.deepEquals(state.files, files) ||
      !Bun.deepEquals(state.revisions, revisions);
    if (state.historyId && state.historyId !== historyId) {
      state.checks = collection();
      state.snapshots = collection();
    }
    Object.assign(state, {
      historyId,
      currentRevision,
      pendingChanges,
      files,
      revisions,
    });
    return dropArtifactsOfGoneRevisions(state) || changed;
  });
}

function revisionState(
  entry: HistoryEntry,
  blob: (hash: string | null) => string | null,
): RevisionState {
  const targets = entry.targets?.filter((target) =>
    entry.files.some((file) => file.path === target.file),
  );
  return {
    actor: entry.who,
    ...(targets?.length && { targets }),
    label: entry.label,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    ...(entry.undoes && { undoes: entry.undoes }),
    ...(entry.restoredTo && { restoredTo: entry.restoredTo }),
    files: Object.fromEntries(
      entry.files.map((file) => [
        file.path,
        { before: blob(file.before), after: blob(file.after) },
      ]),
    ),
  };
}

function dropArtifactsOfGoneRevisions(state: VideoState): boolean {
  let dropped = false;
  const kept = (revision: string) =>
    Boolean(state.revisions[revision]) ||
    Boolean(state.renders?.retainedRevisions?.includes(revision));
  for (const artifacts of [state.checks, state.snapshots]) {
    for (const revision of Object.keys(artifacts.revisions)) {
      if (!kept(revision)) {
        delete artifacts.revisions[revision];
        dropped = true;
      }
    }
    if (
      artifacts.latest?.revision &&
      !state.revisions[artifacts.latest.revision]
    ) {
      artifacts.latest = null;
      dropped = true;
    }
  }
  return dropped;
}
