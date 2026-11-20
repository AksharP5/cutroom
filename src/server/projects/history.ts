import {
  HistoryRefusedError,
  STUDIO_SIGNATURE_MANIFEST_PATHS,
} from "@hyperframes/studio-server";
import type { HistoryListItem, HistoryWho } from "@hyperframes/studio-server";
import { realpath } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import {
  inFreezeAssets,
  inMediaTrash,
  isFreezeExport,
  isMediaItem,
} from "../../shared/media";
import { PROJECT_DOCUMENT_PATH } from "../../shared/project";
import type { Project } from "../../shared/project";
import { protectedPath } from "../../shared/sourcePaths";
import { ownerWho } from "./historyActor";
import type { historyActor } from "./historyActor";
import { mediaRemoveLabel } from "./mediaTrash";
import { projectPath, projectWritePath } from "./path";
import type { ReviewService } from "./review";

export const HistoryRequestSchema = z.strictObject({
  entryId: z.string().min(1).max(128).optional(),
  requestId: z.uuid().optional(),
});

type Direction = "undo" | "redo";
type Entry = HistoryListItem;

const isOwner = (who: HistoryWho) => who.key === ownerWho.key;

function belongsTo(entry: Entry, who: HistoryWho) {
  if (!who.key || entry.who.kind !== who.kind) return false;
  if (entry.who.key) return entry.who.key === who.key;
  if (!isOwner(who) || entry.who.name !== ownerWho.name) return false;
  // These routes formerly stamped MCP and editor calls alike as "You".
  if (entry.label === "Import transcript") return false;
  return !(
    entry.files.length === 1 &&
    entry.files[0]?.path === PROJECT_DOCUMENT_PATH &&
    ["Add comment", "Add drawing", "Update comment", "Remove comment"].includes(
      entry.label,
    )
  );
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

function editable(entry: Entry) {
  if (
    entry.incomplete ||
    !entry.files.length ||
    entry.restoredTo ||
    entry.undoes
  )
    return false;
  if (
    entry.who.kind === "outside" &&
    entry.files.some(({ path }) => isMediaItem(path) || inMediaTrash(path))
  )
    return false;
  if (entry.category === "media") return isMediaOperation(entry);
  return (
    isMediaOperation(entry) ||
    entry.files.every(
      ({ path }) =>
        !protectedPath(path) ||
        (entry.who.kind !== "outside" &&
          (inFreezeAssets(path) ||
            /^assets\/fonts\/[^/]+\.(?:woff2?|[ot]tf)$/i.test(path))),
    )
  );
}

export function historyCandidate(
  entries: readonly Entry[],
  direction: Direction,
  who: HistoryWho,
) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.restoredTo) return;
    if (!entry.undoes) {
      if (
        !belongsTo(entry, who) ||
        !(entry.who.key
          ? entry.files.length || entry.incomplete
          : editable(entry))
      )
        continue;
      if (direction === "redo") return;
      if (!entry.undone) return entry;
      continue;
    }
    if (
      direction === "redo" &&
      !entry.undone &&
      entry.replay === "ordinary" &&
      belongsTo(entry, who)
    ) {
      const original = byId.get(entry.undoes);
      if (original?.undone && editable(original) && belongsTo(original, who))
        return entry;
    }
  }
}

export function historySummary(entries: readonly Entry[], who: HistoryWho) {
  const undo = historyCandidate(entries, "undo", who);
  const redo = historyCandidate(entries, "redo", who);
  return {
    entries: entries.map(({ who, requestId: _requestId, ...entry }) => ({
      ...entry,
      who: { kind: who.kind, name: who.name },
    })),
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

class ReplayConflict extends HttpError {
  constructor(
    message: string,
    readonly conflict: { files: string[]; newer: string[] },
  ) {
    super(409, message);
  }
}

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

function guardLaterEdits(
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
    if (entry.undoes && !redoOf(entry) && byId.get(root.id)!.index > anchor)
      return [];
    const category = root.category;
    const files = entry.files.filter(({ path, before, after }) => {
      if (paths.has(path)) return true;
      if (category === "marker" || category === "text") return false;
      if (original.category === "marker") return /\.html?$/i.test(path);
      if (!structural) return false;
      return (
        !protectedPath(path) ||
        (before !== null && before !== after && isMediaItem(path))
      );
    });
    return files.length ? [{ entry, files }] : [];
  });
  if (!conflicts.length) return;
  const last = conflicts.at(-1)!.entry;
  throw new ReplayConflict(
    `Can't ${direction} ${original.label}. ${last.who.name} changed related content: ${last.label}.`,
    {
      files: [
        ...new Set(
          conflicts.flatMap(({ files }) => files.map(({ path }) => path)),
        ),
      ],
      newer: conflicts.map(({ entry }) => entry.id),
    },
  );
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
  try {
    const result = await reviews.replayHistory(
      project,
      actor.review,
      direction,
      async (history) => {
        const result = await history.revert(
          who,
          async (entries) => {
            const target = input.entryId
              ? entries.find(({ id }) => id === input.entryId)
              : historyCandidate(entries, direction, who);
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
            await validatePaths(project, target);
            if (original.incomplete)
              throw new HttpError(
                409,
                `Can't ${direction} ${original.label}. History did not capture all of its file changes.`,
              );
            if (
              !editable(original) ||
              (!isOwner(who) &&
                (!belongsTo(original, who) ||
                  (direction === "redo" && !belongsTo(target, who))))
            )
              throw new HttpError(
                409,
                "This history action isn't available to this editor.",
              );
            label = original.label;
            originalId = original.id;
            guardLaterEdits(entries, target, original, direction);
            return {
              id: target.id,
              replay:
                !input.entryId ||
                historyCandidate(entries, direction, who)?.id === target.id
                  ? "ordinary"
                  : "explicit",
            };
          },
          {
            requestId:
              input.requestId &&
              `${direction}:${input.entryId ?? ""}:${input.requestId}`,
            writeToken: crypto.randomUUID(),
          },
        );
        if (result.ok && result.repeated && direction === "redo") {
          const undoId = result.entry?.undoes;
          originalId = history.list().find(({ id }) => id === undoId)?.undoes;
        }
        return result;
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
      originalId:
        originalId ?? (direction === "undo" ? entry?.undoes : undefined),
    };
  } catch (error) {
    if (error instanceof ReplayConflict)
      return {
        ok: false as const,
        error: error.message,
        conflict: error.conflict,
      };
    if (error instanceof HistoryRefusedError)
      throw new HttpError(409, error.message);
    throw error;
  }
}
