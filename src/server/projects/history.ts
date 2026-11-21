import { STUDIO_SIGNATURE_MANIFEST_PATHS } from "@hyperframes/studio-server";
import { HistoryRefusedError } from "../history/projectHistory";
import type {
  HistoryEntry,
  HistoryFileChange,
  HistoryWho,
} from "../history/historyLog";
import type {
  HistoryListItem,
  ProjectHistory,
} from "../history/projectHistory";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import {
  inFreezeAssets,
  inMediaTrash,
  isFreezeExport,
  isMediaItem,
  localMediaPath,
} from "../../shared/media";
import {
  PROJECT_DOCUMENT_PATH,
  ProjectDocumentSchema,
  emptyProjectDocument,
} from "../../shared/project";
import type { Project } from "../../shared/project";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import { protectedPath } from "../../shared/sourcePaths";
import { ownerWho } from "./historyActor";
import type { historyActor } from "./historyActor";
import { reverseDocument } from "./historyDocument";
import { reverseTimeline, timelineReplayCache } from "./historyTimeline";
import { mediaRemoveLabel } from "./mediaTrash";
import { projectPath, projectWritePath } from "./path";
import { readHistorySkips, recordHistorySkip } from "./historySkips";
import type { ReviewService } from "./review";

export const HistoryRequestSchema = z.strictObject({
  entryId: z.string().min(1).max(128).optional(),
  expectedEntryId: z.string().min(1).max(128).nullable().optional(),
  skip: z.literal(true).optional(),
  requestId: z.uuid().optional(),
  withEntries: z.array(z.string().min(1).max(128)).min(1).max(100).optional(),
  composition: z.string().min(1).max(1024).optional(),
});

type Direction = "undo" | "redo";
type Entry = HistoryListItem;

const isOwner = (who: HistoryWho) => who.key === ownerWho.key;

function belongsTo(entry: Entry, who: HistoryWho) {
  if (!who.key || entry.who.kind !== who.kind) return false;
  if (isOwner(who)) return true;
  return entry.who.key === who.key;
}

function actorName(author: HistoryWho, caller: HistoryWho) {
  return author.kind === "agent" &&
    caller.kind === "agent" &&
    author.name === caller.name &&
    author.key !== caller.key
    ? `Another ${author.name} session`
    : author.name;
}

function isMediaOperation(entry: Entry) {
  if (entry.who.kind === "outside") return false;
  const mediaPath = (path: string) => isMediaItem(path) || isFreezeExport(path);
  const moved = entry.files.filter(
    ({ path, before, after }) =>
      (before === null || after === null) &&
      (mediaPath(path) || inMediaTrash(path)),
  );
  const pairs = (
    source: Entry["files"][number],
    destination: Entry["files"][number],
  ) =>
    source.before !== null &&
    source.after === null &&
    destination.before === null &&
    destination.after === source.before &&
    mediaPath(source.path) &&
    (inMediaTrash(destination.path)
      ? entry.category === "media" ||
        isFreezeExport(source.path) ||
        entry.label === mediaRemoveLabel(source.path)
      : mediaPath(destination.path) &&
        dirname(destination.path) === dirname(source.path) &&
        (entry.category === "media" || entry.label.startsWith("Rename ")));
  return (
    moved.length >= 2 &&
    moved.every((file) =>
      moved.some((other) => pairs(file, other) || pairs(other, file)),
    )
  );
}

function isImport(entry: Entry) {
  return (
    entry.category === "import" ||
    (entry.files.length > 0 &&
      entry.files.every(
        ({ path, before, after }) =>
          isMediaItem(path) && before === null && after !== null,
      ))
  );
}

function editable(entry: Entry) {
  if (
    entry.who.kind === "outside" ||
    isImport(entry) ||
    entry.incomplete ||
    !entry.files.length ||
    entry.restoredTo ||
    entry.undoes
  )
    return false;
  if (entry.category === "media") return isMediaOperation(entry);
  return (
    isMediaOperation(entry) ||
    entry.files.every(
      ({ path }) =>
        !protectedPath(path) ||
        inFreezeAssets(path) ||
        /^assets\/fonts\/[^/]+\.(?:woff2?|[ot]tf)$/i.test(path),
    )
  );
}

export function historyCandidate(
  entries: readonly Entry[],
  direction: Direction,
  who: HistoryWho,
  skipped?: ReadonlySet<string>,
) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.restoredTo) return;
    if (skipped?.has(entry.id)) continue;
    if (!entry.undoes) {
      if (
        !belongsTo(entry, who) ||
        !(editable(entry) || (entry.incomplete && !isImport(entry)))
      )
        continue;
      if (direction === "redo") return;
      if (!entry.undone) return entry;
      continue;
    }
    if (
      direction === "redo" &&
      !entry.undone &&
      (entry.replay === "ordinary" ||
        (isOwner(who) && entry.replay !== undefined)) &&
      belongsTo(entry, who)
    ) {
      const original = byId.get(entry.undoes);
      if (
        original?.undone &&
        editable(original) &&
        (isOwner(who) || belongsTo(original, who))
      )
        return entry;
    }
  }
}

export async function historySummary(
  project: Project,
  entries: readonly Entry[],
  who: HistoryWho,
) {
  const skipped = isOwner(who) ? await readHistorySkips(project) : undefined;
  const undo = historyCandidate(entries, "undo", who, skipped);
  const redo = historyCandidate(entries, "redo", who, skipped);
  return {
    entries: entries.map(({ who: author, requestId: _requestId, ...entry }) => {
      const display = { kind: author.kind, name: author.name };
      return {
        ...entry,
        ...(isImport({ ...entry, who: author }) && {
          label: `${author.kind === "outside" ? "Added" : "Imported"} ${entry.files.length} ${entry.files.length === 1 ? "file" : "files"}`,
        }),
        who: display,
        author: display,
        mine: belongsTo({ ...entry, who: author }, who),
        step: !skipped?.has(entry.id) && editable({ ...entry, who: author }),
        ...(skipped?.has(entry.id) && { skipped: true }),
      };
    }),
    canUndo: !!undo,
    canRedo: !!redo,
    nextUndo: undo ? { id: undo.id, label: undo.label } : null,
    nextRedo: redo
      ? {
          id: redo.id,
          label:
            entries.find(({ id }) => id === redo.undoes)?.label ?? redo.label,
        }
      : null,
  };
}

type Blocker = {
  id: string;
  label: string;
  author: { kind: HistoryWho["kind"]; name: string };
};

class ReplayConflict extends HttpError {
  constructor(
    message: string,
    readonly conflict: {
      files: string[];
      newer: string[];
      blocking?: Blocker[];
      undoTogether?: { entryId: string; withEntries: string[] };
      skipEntryId?: string;
    },
  ) {
    super(409, message);
  }
}

class ReplaySnapshotChanged extends Error {}

class HistoryAdvanced extends HttpError {
  constructor() {
    super(409, "The next history action changed. Use Undo or Redo again.");
  }
}

/**
 * Uncached composition inverses one group search may compute. Finding a group of k edits takes
 * about k; pruning it takes about k²/2, so groups up to 5 are pruned fully.
 */
const GROUP_PLAN_STEPS = 24;

const appSidecars = new Set([
  ...STUDIO_SIGNATURE_MANIFEST_PATHS,
  ".media/manifest.jsonl",
]);

async function validatePaths(project: Project, entry: Entry) {
  for (const { path } of entry.files) {
    if (appSidecars.has(path)) {
      const absolute = await projectPath(project, path, true);
      if (
        relative(await realpath(project.path), absolute)
          .split(sep)
          .join("/") === path
      )
        continue;
    }
    await projectWritePath(project, path, {
      sourceOnly: false,
      allowMissing: true,
    });
  }
}

function relatedEdits(
  entries: readonly Entry[],
  target: Entry,
  original: Entry,
  direction: Direction,
) {
  const byId = new Map<string, { index: number; root: Entry; entry: Entry }>();
  for (const [index, entry] of entries.entries())
    byId.set(entry.id, {
      index,
      root: (entry.undoes && byId.get(entry.undoes)?.root) || entry,
      entry,
    });
  const redoOf = (entry: Entry) =>
    entry.undoes && byId.get(entry.undoes)?.entry.undoes;
  const activeRedo =
    direction === "undo" &&
    entries.findLast((entry) => !entry.undone && redoOf(entry) === original.id);
  const anchor = byId.get((activeRedo || target).id)!.index;
  const paths = new Set(target.files.map(({ path }) => path));
  const structural =
    original.category !== "text" && original.category !== "marker";
  const conflicts = entries.slice(anchor + 1).flatMap((entry) => {
    const { root } = byId.get(entry.id)!;
    if (entry.undone || root.id === original.id) return [];
    if (entry.incomplete)
      return [
        { entry, files: entry.files.length ? entry.files : target.files },
      ];
    // A later edit and its undo cancel. An undo of earlier content can still conflict.
    if (entry.undoes) {
      const originalIndex = byId.get(root.id)!.index;
      const reversesReplay = redoOf(entry);
      if (!reversesReplay && originalIndex > anchor) return [];
      if (
        reversesReplay &&
        originalIndex <= anchor &&
        byId.get(entry.undoes)!.index > anchor
      )
        return [];
    }
    const category = root.category;
    const files = entry.files.filter(({ path, before, after }) => {
      if (paths.has(path)) return true;
      if (category === "marker")
        return (
          structural &&
          path === PROJECT_DOCUMENT_PATH &&
          target.files.some(({ path }) => /\.html?$/i.test(path))
        );
      if (category === "text") return false;
      if (original.category === "marker") return /\.html?$/i.test(path);
      if (!structural) return false;
      return (
        !protectedPath(path) ||
        (before !== null && before !== after && isMediaItem(path))
      );
    });
    return files.length ? [{ entry, files }] : [];
  });
  return conflicts;
}

type ReplayStep = {
  id: string;
  replay: NonNullable<HistoryEntry["replay"]>;
  files: HistoryFileChange[];
};

function replayCache(history: ProjectHistory) {
  const sources = new Map<string, Promise<string>>();
  const text = (hash: string, bytes?: Buffer) => {
    let source = sources.get(hash);
    if (!source) {
      source = (bytes ? Promise.resolve(bytes) : history.readBlob(hash)).then(
        (blob) => blob.toString("utf8"),
      );
      sources.set(hash, source);
    }
    return source;
  };
  const documents = new Map<
    string,
    Promise<ReturnType<typeof ProjectDocumentSchema.safeParse> | undefined>
  >();
  const document = (hash: string, bytes?: Buffer) => {
    let parsed = documents.get(hash);
    if (!parsed) {
      parsed = text(hash, bytes).then((source) => {
        try {
          return ProjectDocumentSchema.safeParse(JSON.parse(source));
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      });
      documents.set(hash, parsed);
    }
    return parsed;
  };
  // A group search replans the same file inverses many times. Keyed by the hashes and settings they read.
  const reversals = new Map<
    string,
    {
      source: string;
      structural: boolean;
      content?: Buffer;
      hash?: string;
    } | null
  >();
  return { text, document, timeline: timelineReplayCache(), reversals };
}

function replayPlan(
  cache: ReturnType<typeof replayCache>,
  currentHash: (path: string) => string | null,
) {
  const blobs = new Map<string, Buffer>();
  const current = new Map<string, string | null>();
  const steps: ReplayStep[] = [];
  const hashOf = (path: string) =>
    current.has(path) ? current.get(path)! : currentHash(path);
  const text = (hash: string) => cache.text(hash, blobs.get(hash));
  const remember = (source: string) => {
    const content = Buffer.from(source);
    const hash = createHash("sha256").update(content).digest("hex");
    blobs.set(hash, content);
    return hash;
  };
  return {
    steps,
    blobs,
    async add(
      target: Entry,
      original: Entry,
      replay: ReplayStep["replay"],
      later: ReturnType<typeof relatedEdits>,
    ) {
      const changes: HistoryFileChange[] = [];
      const document = target.files.find(
        ({ path }) => path === PROJECT_DOCUMENT_PATH,
      );
      const currentDocument = hashOf(PROJECT_DOCUMENT_PATH);
      let restoredDocument = document ? document.before : currentDocument;
      const conflict = new Set<string>();
      const checkedReferences = new Set<string>();
      const movingMedia = isMediaOperation(original);
      if (
        movingMedia ||
        target.files.some(
          ({ path, before }) =>
            before === null &&
            /\.(?:html?|css|[cm]?[jt]s|svg|vtt|woff2?|[ot]tf)$/i.test(path),
        )
      ) {
        for (const row of later)
          for (const { path } of row.files) conflict.add(path);
      }
      if (document && document.after !== currentDocument) {
        if (
          !movingMedia &&
          document.before &&
          document.after &&
          currentDocument
        ) {
          const [before, after, current] = await Promise.all(
            [document.before, document.after, currentDocument].map((hash) =>
              cache.document(hash, blobs.get(hash)),
            ),
          );
          const merged =
            before?.success && after?.success && current?.success
              ? reverseDocument(before.data, after.data, current.data)
              : null;
          if (merged !== null) restoredDocument = remember(merged);
          else conflict.add(document.path);
        } else conflict.add(document.path);
      }
      for (const file of target.files) {
        const standing = hashOf(file.path);
        let restored = file.before;
        if (file === document) {
          restored = restoredDocument;
        } else if (
          !movingMedia &&
          /\.html?$/i.test(file.path) &&
          file.before &&
          file.after &&
          standing &&
          (standing !== file.after ||
            Boolean(document && document.after !== currentDocument) ||
            later.some((row) =>
              row.files.some(({ path }) => path === PROJECT_DOCUMENT_PATH),
            ))
        ) {
          const readDocument = async (hash: string | null) =>
            hash
              ? cache.document(hash, blobs.get(hash))
              : { success: true as const, data: emptyProjectDocument() };
          const settings = async (hash: string | null) => {
            const value = await readDocument(hash).catch((error: unknown) => {
              if (error instanceof SyntaxError) return;
              throw error;
            });
            return value?.success
              ? (value.data.timelines[file.path] ?? emptyTimelineSettings())
              : null;
          };
          // An HTML-only entry has no before/after sidecar hashes. Use the first later sidecar's before state.
          const standingAtEdit = later
            .flatMap(({ entry }) => entry.files)
            .find(({ path }) => path === PROJECT_DOCUMENT_PATH);
          const priorDocument = standingAtEdit
            ? standingAtEdit.before
            : currentDocument;
          const [before, after, current, result] = await Promise.all([
            settings(document ? document.before : priorDocument),
            settings(document ? document.after : priorDocument),
            settings(currentDocument),
            settings(restoredDocument),
          ]);
          if (!before || !after || !current || !result) {
            conflict.add(file.path);
            continue;
          }
          const [old, written, now] = await Promise.all([
            text(file.before),
            text(file.after),
            text(standing),
          ]);
          const key = JSON.stringify([
            file.path,
            file.before,
            file.after,
            standing,
            before,
            after,
            current,
            result,
          ]);
          let merged = cache.reversals.get(key);
          if (merged === undefined) {
            merged = reverseTimeline(
              cache.timeline,
              file.path,
              { before: old, after: written, current: now },
              { before, after, current, restored: result },
            );
            cache.reversals.set(key, merged);
          }
          if (merged === null) {
            conflict.add(file.path);
            if (
              later.some(({ files }) =>
                files.some(({ path }) => path === PROJECT_DOCUMENT_PATH),
              )
            )
              conflict.add(PROJECT_DOCUMENT_PATH);
            continue;
          }
          if (merged.source === old) restored = file.before;
          else {
            merged.content ??= Buffer.from(merged.source);
            merged.hash ??= createHash("sha256")
              .update(merged.content)
              .digest("hex");
            blobs.set(merged.hash, merged.content);
            restored = merged.hash;
          }
          if (!merged.structural) checkedReferences.add(file.path);
        } else if (standing !== file.after) {
          conflict.add(file.path);
        } else if (
          /\.html?$/i.test(file.path) &&
          later.some(
            ({ entry, files }) =>
              files.some(({ path }) => path === file.path) &&
              !entry.undoes &&
              entry.who.kind !== "outside",
          )
        ) {
          // A later write may have returned the file to the same bytes. It still owns that write.
          conflict.add(file.path);
        }
        if (restored !== standing)
          changes.push({ path: file.path, before: standing, after: restored });
      }
      if (conflict.size) return [...conflict];
      for (const file of later.length ? changes : []) {
        if (
          !file.after ||
          !/\.html?$/i.test(file.path) ||
          checkedReferences.has(file.path)
        )
          continue;
        const media = async (hash: string) => {
          const source = await text(hash);
          return cache.timeline.media(file.path, source);
        };
        const previous = new Set(file.before ? await media(file.before) : []);
        for (const reference of await media(file.after)) {
          if (previous.has(reference)) continue;
          const path = localMediaPath(file.path, reference);
          const rootPath =
            file.path.includes("/") && !reference.startsWith("../")
              ? localMediaPath("index.html", reference)
              : null;
          const exists = (candidate: string) =>
            (
              changes.find((change) => change.path === candidate) ?? {
                after: hashOf(candidate),
              }
            ).after !== null;
          if (path && !exists(path) && !(rootPath && exists(rootPath)))
            return [file.path, path];
        }
      }
      for (const change of changes) current.set(change.path, change.after);
      steps.push({ id: target.id, replay, files: changes });
      return [];
    },
  };
}

type Actor = ReturnType<typeof historyActor>;

export async function replayHistory(
  reviews: ReviewService,
  project: Project,
  actor: Actor,
  direction: Direction,
  input: z.output<typeof HistoryRequestSchema>,
) {
  const { who } = actor;
  let label: string | undefined;
  let originalId: string | undefined;
  let kept: Entry[] = [];
  let newest: Entry | undefined;
  let skipEntryId: string | undefined;
  let skippedEdit: { id: string; label: string } | undefined;
  try {
    const result = await reviews.replayHistory(
      project,
      actor.review,
      direction,
      async (history) => {
        const requestId =
          input.requestId &&
          `${direction}:${input.entryId ?? ""}:${input.requestId}`;
        const skipped = isOwner(who)
          ? await readHistorySkips(project)
          : new Set<string>();
        for (let attempt = 0; ; attempt++) {
          await history.checkpoint();
          const entries = history.list();
          const head = entries.at(-1)?.id;
          const files = history.peek(head ?? "start") ?? {};
          const inspected = new Map<string, string | null>();
          const currentHash = (path: string) => {
            const hash = Object.hasOwn(files, path) ? files[path]! : null;
            inspected.set(path, hash);
            return hash;
          };
          const prepare = async () => {
            if (
              input.withEntries &&
              (!isOwner(who) || direction !== "undo" || !input.entryId)
            )
              throw new HttpError(
                409,
                "Only the owner can confirm a grouped undo.",
              );
            const next = historyCandidate(entries, direction, who, skipped);
            if (
              input.expectedEntryId !== undefined &&
              input.expectedEntryId !== (next?.id ?? null)
            )
              throw new HistoryAdvanced();
            if (
              input.skip &&
              (!isOwner(who) ||
                direction !== "undo" ||
                input.entryId !== next?.id ||
                input.withEntries)
            )
              throw new HistoryAdvanced();
            const target = input.entryId
              ? entries.find(({ id }) => id === input.entryId)
              : next;
            newest = entries.findLast(
              (entry) => !entry.undone && !entry.undoes,
            );
            if (!target && !input.entryId) return;
            const original =
              direction === "undo"
                ? target
                : entries.find(({ id }) => id === target?.undoes);
            if (
              !target ||
              !original ||
              target.undone ||
              (direction === "redo" && !original.undone) ||
              entries
                .slice(entries.indexOf(original) + 1)
                .some((entry) => entry.restoredTo)
            )
              throw new HttpError(
                409,
                "The selected history action is no longer available.",
              );
            const ordinaryOwnerUndo =
              isOwner(who) &&
              direction === "undo" &&
              input.entryId === undefined &&
              next?.id === target.id;
            skipEntryId = ordinaryOwnerUndo ? target.id : undefined;
            const skip = skipEntryId ? { skipEntryId } : {};
            if (input.skip) {
              await recordHistorySkip(project, skipped, target.id, entries);
              skipped.add(target.id);
              const after = historyCandidate(entries, "undo", who, skipped);
              skippedEdit = {
                id: target.id,
                label: after
                  ? `Kept ${target.label}. Undo takes back ${after.label} next.`
                  : `Kept ${target.label}. Nothing older of yours to undo.`,
              };
              return;
            }
            if (original.incomplete) {
              throw new ReplayConflict(
                `Can't ${direction} ${original.label}. History did not capture all of its file changes.`,
                { files: [], newer: [], ...skip },
              );
            }
            if (
              !isOwner(who) &&
              (!belongsTo(original, who) ||
                (direction === "redo" && !belongsTo(target, who)))
            )
              throw new HttpError(
                409,
                "This history action isn't available to this editor.",
              );
            await validatePaths(project, target);
            if (!editable(original))
              throw new HttpError(
                409,
                "This history action isn't available to this editor.",
              );
            label = original.label;
            originalId = original.id;
            const cache = replayCache(history);
            const plan = replayPlan(cache, currentHash);
            const replay =
              !input.entryId || next?.id === target.id
                ? "ordinary"
                : "explicit";
            const later = relatedEdits(entries, target, original, direction);
            const conflicts = await plan.add(target, original, replay, later);
            if (!conflicts.length) {
              if (input.withEntries)
                throw new HttpError(
                  409,
                  "The edits in the way changed. Use Undo again.",
                );
              kept = entries
                .slice(entries.indexOf(target) + 1)
                .filter(
                  (entry) =>
                    !entry.undone && editable(entry) && !belongsTo(entry, who),
                );
              return plan;
            }
            const related = (rows: typeof later, files: string[]) =>
              rows.filter((row) =>
                row.files.some(({ path }) => files.includes(path)),
              );
            const blocking = related(later, conflicts);
            const describe = ({ id, label, who }: Entry) => ({
              id,
              label,
              author: { kind: who.kind, name: who.name },
            });
            const canGroup = (entry: Entry) =>
              editable(entry) &&
              !isMediaOperation(entry) &&
              entry.files.every(
                ({ before, after, path }) =>
                  before !== null &&
                  after !== null &&
                  !protectedPath(path) &&
                  !isMediaItem(path),
              );
            let together: ReturnType<typeof replayPlan> | undefined;
            let timedOut = false;
            // Test the proposed inverses against a virtual project, newest first. Inverses are
            // cached by the files they read, so a replan only pays for the steps that changed.
            // The search is bounded by computed inverses, not time, so a loaded machine finds the same group.
            let steps = GROUP_PLAN_STEPS;
            const validated = new Set<string>();
            const planGroup = async (selected: ReadonlySet<string>) => {
              const combined = replayPlan(cache, currentHash);
              const inverse = entries
                .filter(({ id }) => selected.has(id))
                .reverse();
              const reverted = new Set<string>();
              for (const entry of [...inverse, target]) {
                if (steps <= 0) return;
                if (!validated.has(entry.id)) {
                  await validatePaths(project, entry);
                  validated.add(entry.id);
                }
                const active = entries.filter(({ id }) => !reverted.has(id));
                const rows = relatedEdits(active, entry, entry, "undo");
                const computed = cache.reversals.size;
                const files = await combined.add(entry, entry, "group", rows);
                steps -= cache.reversals.size - computed;
                if (files.length) return { rows, files };
                reverted.add(entry.id);
              }
              return { combined };
            };
            const groupable =
              isOwner(who) && direction === "undo" && canGroup(original);
            if (input.withEntries) {
              // The owner confirmed this exact group, so plan it once instead of searching again.
              const confirmed = input.withEntries.flatMap(
                (id) => entries.find((entry) => entry.id === id) ?? [],
              );
              const attempt =
                groupable &&
                confirmed.length === input.withEntries.length &&
                confirmed.every(
                  (entry) =>
                    !entry.undone &&
                    entries.indexOf(entry) > entries.indexOf(target) &&
                    canGroup(entry),
                )
                  ? await planGroup(new Set(input.withEntries))
                  : undefined;
              const planned = attempt?.combined?.steps
                .slice(0, -1)
                .map(({ id }) => id);
              if (
                attempt?.combined &&
                Bun.deepEquals(planned, input.withEntries)
              )
                return attempt.combined;
              throw new HttpError(
                409,
                "The edits in the way changed. Use Undo again.",
              );
            }
            if (groupable) {
              const selected = new Set<string>();
              let candidates = blocking;
              while (selected.size < 100) {
                const row = candidates.at(-1);
                if (!row || !canGroup(row.entry) || selected.has(row.entry.id))
                  break;
                selected.add(row.entry.id);
                const attempt = await planGroup(selected);
                if (!attempt) {
                  timedOut = true;
                  break;
                }
                if (attempt.combined) {
                  together = attempt.combined;
                  break;
                }
                candidates = related(attempt.rows, attempt.files);
              }
              // A newer row can touch the same file without contributing to the conflict.
              // Remove it if the remaining inverses still resolve the block. Out of steps,
              // the group found so far still resolves it, so it is offered as it is.
              if (together && selected.size > 1) {
                for (const id of [...selected]) {
                  selected.delete(id);
                  const attempt = await planGroup(selected);
                  if (attempt?.combined) together = attempt.combined;
                  else selected.add(id);
                  if (!attempt) break;
                }
              }
            }
            const ids = together?.steps.slice(0, -1).map(({ id }) => id);
            const blockers = ids?.length
              ? ids
                  .flatMap(
                    (id) => entries.find((entry) => entry.id === id) ?? [],
                  )
                  .reverse()
              : blocking.map(({ entry }) => entry);
            const latest = blockers.at(-1);
            throw new ReplayConflict(
              timedOut
                ? `Can't ${direction} ${original.label} by itself. Too many related edits depend on it.`
                : isMediaOperation(original)
                  ? `Can't ${direction} ${original.label}. The project changed since. You can move the file from Media.`
                  : latest
                    ? `Can't ${direction} ${original.label} by itself. ${actorName(latest.who, who)} made a related edit: ${latest.label}.`
                    : `Can't ${direction} ${original.label}. Newer changes affect ${conflicts.join(", ")}.`,
              {
                files: conflicts,
                newer: blockers.map(({ id }) => id),
                blocking: blockers.map(describe),
                ...(ids?.length
                  ? { undoTogether: { entryId: target.id, withEntries: ids } }
                  : skip),
              },
            );
          };
          // The engine handles retrying an already committed request. No calculation is needed for it.
          const repeated =
            requestId &&
            entries.some(
              (entry) =>
                entry.requestId === requestId && entry.who.key === who.key,
            );
          const plan = repeated ? undefined : await prepare();
          if (!plan && !repeated) return { ok: true as const, entry: null };
          try {
            const result = await history.revert(
              who,
              (standing, hash) => {
                if (
                  standing.length !== entries.length ||
                  standing.at(-1)?.id !== head ||
                  [...inspected].some(([path, seen]) => hash(path) !== seen)
                )
                  throw new ReplaySnapshotChanged();
                return plan;
              },
              { requestId, writeToken: crypto.randomUUID() },
            );
            if (result.ok && result.repeated && direction === "redo") {
              const undoId = result.entry?.undoes;
              originalId = history
                .list()
                .find(({ id }) => id === undoId)?.undoes;
            }
            return result;
          } catch (error) {
            if (!(error instanceof ReplaySnapshotChanged)) throw error;
            if (attempt > 0) throw new HistoryAdvanced();
            kept = [];
          }
        }
      },
    );
    if (!result.ok) {
      throw new ReplayConflict(
        `Can't ${direction} ${label}. Newer edits changed ${result.conflict.files.join(", ")}.`,
        result.conflict,
      );
    }
    const entry = result.entry;
    return {
      ok: true as const,
      entry: entry && {
        id: entry.id,
        label: entry.label,
        undoes: entry.undoes,
        who: { kind: entry.who.kind, name: entry.who.name },
        files: entry.files,
      },
      action: direction,
      skipped: skippedEdit,
      ...(!entry &&
        !skippedEdit && {
          message:
            newest && !belongsTo(newest, who)
              ? `Nothing of yours to ${direction}. ${actorName(newest.who, who)} made the last change.`
              : `Nothing of yours to ${direction}.`,
        }),
      ...(result.removedNotes.length && {
        removedNotes: result.removedNotes.map(({ id }) => id),
        notesBefore: result.notesBefore,
      }),
      ...(kept.length &&
        entry && {
          kept: {
            count: kept.length,
            authors: [...new Set(kept.map(({ who }) => who.name))],
          },
        }),
      originalId:
        originalId ?? (direction === "undo" ? entry?.undoes : undefined),
    };
  } catch (error) {
    if (error instanceof HistoryAdvanced)
      return {
        ok: false as const,
        error: error.message,
        code: "history-advanced",
      };
    if (error instanceof ReplayConflict)
      return {
        ok: false as const,
        error: error.message,
        conflict: error.conflict,
      };
    if (
      skipEntryId &&
      !input.skip &&
      (error instanceof HistoryRefusedError ||
        (error instanceof HttpError && error.status === 409))
    )
      return {
        ok: false as const,
        error: error.message,
        conflict: { files: [], newer: [], skipEntryId },
      };
    if (error instanceof HistoryRefusedError)
      throw new HttpError(409, error.message);
    throw error;
  }
}
