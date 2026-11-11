import { randomUUID } from "node:crypto";
import type { ProjectHistory } from "@hyperframes/studio-server";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { z } from "zod";
import {
  AnnotationInputSchema,
  AnnotationPatchSchema,
} from "../../shared/project";
import type {
  Annotation,
  Project,
  ProjectDocument,
} from "../../shared/project";
import {
  NoteContentSchema,
  REVIEW_STATE_PATH,
  ReviewStateSchema,
  migrateLegacyStatus,
  transition,
  unfinishedStatuses,
} from "../../shared/review";
import type {
  ReviewAction,
  ReviewActor,
  ReviewAddSchema,
  ReviewItem,
  ReviewTurn,
} from "../../shared/review";
import { HttpError } from "../../shared/errors";
import { ProjectDocumentError, isMissing, projectPath } from "./store";
import type { ProjectStore } from "./store";
import { ClipEditSchema } from "../../shared/timeline/schema";
import { clipVersions, compositionVersions, missingSignature } from "./changes";
import type { ClipVersions } from "./changes";
import { projectStatePath, projectWritePath } from "./path";
import { posix, relative, sep } from "node:path";
import { STUDIO_SIGNATURE_MANIFEST_PATHS } from "@hyperframes/studio-server";

const ReviewFileSchema = z.object({
  schemaVersion: z.literal(1),
  clipEdits: z
    .array(
      ClipEditSchema.omit({ resolution: true }).extend({
        signature: z.string().optional(),
        beforeSignature: z.string().optional(),
        noteIds: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  changes: z
    .array(
      z.object({
        composition: z.string(),
        clipId: z.string(),
        signature: z.string(),
        noteIds: z.array(z.string()),
      }),
    )
    .default([]),
  items: z.array(
    ReviewStateSchema.extend({
      id: z.string(),
      // What was submitted, so a request survives its content being undone.
      content: NoteContentSchema.optional(),
      // Captures arrive after commit and stay outside content history and review transitions.
      framePath: NoteContentSchema.shape.framePath,
    }),
  ),
});
type ReviewFile = z.infer<typeof ReviewFileSchema>;
/** Accepting a row establishes that target's accepted bytes for its remaining pending rows. */
function acceptEdits(edits: ReviewFile["clipEdits"], ids: Set<string>) {
  const accepted = new Map<string, string>();
  const target = (edit: ReviewFile["clipEdits"][number]) =>
    JSON.stringify([edit.composition, edit.clipId]);
  return edits.map((edit) => {
    if (ids.has(edit.id)) {
      if (!edit.accepted && edit.signature?.startsWith("v3:"))
        accepted.set(target(edit), edit.signature);
      return { ...edit, accepted: true };
    }
    const baseline = accepted.get(target(edit));
    return !edit.accepted &&
      edit.signature?.startsWith("v3:") &&
      baseline !== undefined
      ? { ...edit, beforeSignature: baseline }
      : edit;
  });
}

/** Who changed a sent note's content, and how: "by undo", "outside Cutroom", and so on. */
type Cause = { actor: ReviewActor; how: string };

/** Review status is unreadable. Only review actions stop; transcripts and chat keep working. */
export class ReviewFileError extends HttpError {
  constructor() {
    super(
      422,
      `Review status in ${REVIEW_STATE_PATH} is unreadable. Repair the file to keep reviewing; until then no note changes status and undo, redo, and restore are blocked so no sent request is lost.`,
    );
  }
}

export function addAnnotation(
  store: ProjectStore,
  project: Project,
  input: z.output<typeof AnnotationInputSchema>,
): Promise<Annotation> {
  return store.mutate(
    project,
    input.kind === "drawing" ? "Add drawing" : "Add comment",
    async () => {
      const document = await store.document(project);
      if (input.id && document.annotations.some((note) => note.id === input.id))
        throw new HttpError(409, "A note with this id already exists.");
      const now = new Date().toISOString();
      const annotation = {
        ...input,
        id: input.id ?? randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      document.annotations.push(annotation);
      await store.writeDocument(project, document);
      return annotation;
    },
  );
}

function find(items: ReviewItem[], id: string) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new HttpError(404, "Review note not found.");
  return item;
}

/**
 * The single owner of review state. Every change to a note's status, and every change to a
 * note's content that could race one (delete, edit, undo, redo), runs in one queue per project.
 */
export function createReviewService(store: ProjectStore) {
  const turns = new Map<string, ReviewTurn>();
  const queues = new Map<string, Promise<unknown>>();
  // Outside MCP clients act in this server's lifetime; their claims return to the queue after a restart.
  const external: ReviewTurn = {
    id: `external:${randomUUID()}`,
    kind: "external",
  };
  const outside: Cause = {
    actor: { kind: "agent", turn: external },
    how: "outside Cutroom",
  };

  const serialize = <T>(project: Project, work: () => Promise<T>) => {
    const pending = (queues.get(project.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    queues.set(project.id, pending);
    void pending
      .catch(() => undefined)
      .then(() => {
        if (queues.get(project.id) === pending) queues.delete(project.id);
      });
    return pending;
  };

  const readState = async (project: Project): Promise<ReviewFile> => {
    // A missing `.cutroom` folder means no review state has been saved yet.
    const raw = await projectStatePath(project, REVIEW_STATE_PATH, true)
      .then((path) => readFile(path, "utf8"))
      .catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
    if (raw === null)
      return { schemaVersion: 1, items: [], changes: [], clipEdits: [] };
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ReviewFileError();
    }
    const parsed = ReviewFileSchema.safeParse(json);
    if (!parsed.success) throw new ReviewFileError();
    const state = parsed.data;
    // Move #30's marks into the ledger, keeping their note attribution and source signature.
    for (const change of state.changes) {
      const latest = state.clipEdits.findLast(
        (edit) =>
          edit.composition === change.composition &&
          edit.clipId === change.clipId &&
          !edit.accepted,
      );
      if (latest) {
        latest.signature ??= change.signature;
        for (const edit of state.clipEdits)
          if (
            edit.composition === change.composition &&
            edit.clipId === change.clipId &&
            !edit.accepted
          )
            edit.noteIds = change.noteIds;
      } else
        state.clipEdits.push({
          id: `legacy:${change.composition}:${change.clipId}:${change.signature}`,
          clipId: change.clipId,
          composition: change.composition,
          label: "Edited source",
          by: "agent",
          at: "",
          accepted: false,
          signature: change.signature,
          noteIds: change.noteIds,
        });
    }
    state.changes = [];
    return state;
  };

  const writeState = async (project: Project, state: ReviewFile) => {
    await mkdir(await projectStatePath(project, ".cutroom", true), {
      recursive: true,
    });
    const path = await projectStatePath(project, REVIEW_STATE_PATH, true);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  };

  /**
   * The one place review status is derived and saved. Joins live note content with review.json in
   * the owner's order, applies `change`, and persists the result, so a read never shows a transition
   * that is not saved. Once a note is sent, review.json's copy is the request: if its live content is
   * removed or no longer matches, the note becomes withdrawn, credited to `cause`.
   * Only call inside `serialize`.
   */
  const reconcile = async (
    project: Project,
    cause = outside,
    change: (items: ReviewItem[], document: ProjectDocument) => ReviewItem[] = (
      items,
    ) => items,
  ) => {
    // Review state first: an unreadable review.json must always win over an unreadable
    // cutroom.json, or history could run when it should be blocked.
    const state = await readState(project);
    const document = await store.document(project);
    const live = [external.id, turns.get(project.id)?.id];
    const annotations = new Map(
      document.annotations.map(({ status, ...content }) => [
        content.id,
        { content, status },
      ]),
    );
    const frames = new Map(
      state.items.map((item) => [item.id, item.framePath]),
    );
    const stored = new Set(state.items.map((item) => item.id));
    const entries = [
      ...state.items.flatMap((entry) => {
        const found = annotations.get(entry.id)?.content;
        const request =
          entry.review.status === "open" ? found : (entry.content ?? found);
        return request ? [{ ...entry, request, found }] : [];
      }),
      ...[...annotations.values()]
        .filter(({ content }) => !stored.has(content.id))
        .map(({ content, status }) => ({
          review: migrateLegacyStatus(status, content.updatedAt),
          instructions: [],
          request: content,
          found: content,
        })),
    ];
    const items = entries.map(
      ({ review, instructions, request, found }): ReviewItem => {
        const current = { review, instructions };
        const drift = !found
          ? "Removed"
          : sameContent(found, request)
            ? null
            : "Changed";
        const sent =
          review.status !== "open" &&
          unfinishedStatuses.some((status) => status === review.status);
        if (drift && sent)
          return {
            ...request,
            ...transition(
              current,
              { type: "withdraw", reason: `${drift} ${cause.how}` },
              cause.actor,
            ),
          };
        // A claim whose run has ended (finished, crashed, or a previous server) returns to the queue.
        if (review.status === "working" && !live.includes(review.turnId))
          return {
            ...request,
            ...transition(
              current,
              { type: "release" },
              { kind: "agent", turn: external },
            ),
          };
        return { ...request, ...current };
      },
    );
    // A refused change still saves what reconciling found, without the refused change.
    let refusal: { error: unknown } | undefined;
    let next = items;
    try {
      next = change(items, document);
    } catch (error) {
      refusal = { error };
    }
    const visible = new Set(next.map((item) => item.id));
    const written: ReviewFile = {
      schemaVersion: 1,
      clipEdits: acceptEdits(
        state.clipEdits,
        new Set(
          state.clipEdits
            .filter(
              (edit) =>
                !edit.accepted &&
                edit.noteIds.length &&
                edit.noteIds.every(
                  (id) =>
                    next.find((item) => item.id === id)?.review.status ===
                    "accepted",
                ),
            )
            .map((edit) => edit.id),
        ),
      ),
      changes: [],
      items: [
        ...next.map(({ review, instructions, ...content }) => ({
          id: content.id,
          review,
          instructions,
          ...(frames.get(content.id) && { framePath: frames.get(content.id) }),
          ...(review.status !== "open" && { content }),
        })),
        // Drafts removed by undo keep their entry in case redo brings them back.
        ...state.items.filter((item) => !visible.has(item.id)),
      ],
    };
    // Parsed and built objects order their keys differently; only a real change is written.
    if (!sameContent(written, state)) await writeState(project, written);
    if (refusal) throw refusal.error;
    return next.map((item) => {
      const framePath = frames.get(item.id);
      return framePath ? { ...item, framePath } : item;
    });
  };

  const update = (project: Project, change: Parameters<typeof reconcile>[2]) =>
    serialize(project, () => reconcile(project, outside, change));

  /** Changes a draft's content. Submitted notes only change through review actions. */
  const changeDraft = (
    project: Project,
    id: string,
    label: string,
    change: (annotations: Annotation[], index: number) => Annotation[],
  ) =>
    serialize(project, async () => {
      const [item] = (await reconcile(project)).filter(
        (candidate) => candidate.id === id,
      );
      if (item && item.review.status !== "open")
        throw new HttpError(
          409,
          "This note has been sent. Withdraw it instead, so the reason is recorded.",
        );
      return store.mutate(project, label, async () => {
        const document = await store.document(project);
        const index = document.annotations.findIndex(
          (annotation) => annotation.id === id,
        );
        if (index < 0) throw new HttpError(404, "Annotation not found.");
        document.annotations = change(document.annotations, index);
        await store.writeDocument(project, document);
        return document.annotations.find((annotation) => annotation.id === id);
      });
    });

  /**
   * The agent behind a request. A conversation's token only acts on the project whose run it
   * belongs to, while that run is active; anything else is refused rather than guessed.
   */
  const authorize = (token: string | undefined, projectId?: string) => {
    if (token === undefined || token === "external") return;
    const turn =
      projectId === undefined
        ? [...turns.values()].find(
            (turn) => turn.kind === "message" && turn.token === token,
          )
        : turns.get(projectId);
    if (turn?.kind !== "message" || turn.token !== token)
      throw new HttpError(409, "No Cutroom run is active for this project.");
    return turn;
  };
  const agent = (
    project: Project,
    token: string | undefined,
  ): Extract<ReviewActor, { kind: "agent" }> => ({
    kind: "agent",
    turn: authorize(token, project.id) ?? external,
  });

  /** Project the active history onto the ledger. Undo changes visibility, never approval. */
  const currentEdits = async (project: Project) => {
    const state = await readState(project);
    const history = await store.history(project);
    const entries = history.list();
    const undone = new Set(
      entries.filter((entry) => entry.undone).map((entry) => entry.id),
    );
    const edits = state.clipEdits.filter(
      (edit) => edit.historyId === undefined || !undone.has(edit.historyId),
    );
    const versions = new Map(
      await Promise.all(
        [
          ...new Set(
            edits
              .filter((edit) => edit.by === "agent" && !edit.accepted)
              .map((edit) => edit.composition),
          ),
        ].map(
          async (path) => [path, await clipVersions(project, path)] as const,
        ),
      ),
    );
    return edits.map(
      ({ signature, beforeSignature, noteIds: _noteIds, ...edit }) => {
        if (edit.by === "human" || edit.accepted)
          return { ...edit, resolution: undefined };
        // Old signatures included shared code. They cannot establish an accepted v3 state.
        if (!signature?.startsWith("v3:") || beforeSignature === undefined)
          return { ...edit, resolution: undefined };
        return (versions.get(edit.composition)?.get(edit.clipId) ??
          missingSignature) === beforeSignature
          ? { ...edit, resolution: "source" as const }
          : { ...edit, resolution: undefined };
      },
    );
  };

  const recordEdits = async (
    project: Project,
    composition: string,
    before: ClipVersions,
    after: ClipVersions,
    changed: Set<string | null>,
    actor: ReviewActor | undefined,
    noteIds: string[],
    pendingRows: Awaited<ReturnType<typeof currentEdits>>,
  ) => {
    const entry = (await store.history(project)).list().at(-1);
    const state = await readState(project);
    const pendingIds = new Set(pendingRows.map((edit) => edit.id));
    const at = new Date().toISOString();
    state.clipEdits.push(
      ...[...changed]
        .filter(
          (id) =>
            !state.clipEdits.some(
              (edit) =>
                entry &&
                edit.historyId === entry.id &&
                edit.composition === composition &&
                edit.clipId === id,
            ),
        )
        .map((clipId) => ({
          id: randomUUID(),
          clipId,
          composition,
          label:
            clipId === null
              ? `Edited ${composition} composition`
              : (entry?.label ?? "Edited source"),
          historyId: entry?.id,
          signature: after.get(clipId) ?? missingSignature,
          beforeSignature:
            state.clipEdits.find(
              (edit) =>
                edit.composition === composition &&
                edit.clipId === clipId &&
                pendingIds.has(edit.id) &&
                edit.signature?.startsWith("v3:") &&
                edit.beforeSignature !== undefined &&
                !(entry && edit.historyId === entry.id),
            )?.beforeSignature ??
            before.get(clipId) ??
            missingSignature,
          noteIds,
          at,
          by: actor ? ("agent" as const) : ("human" as const),
          accepted: !actor,
        })),
    );
    // Unreviewed agent work never ages out of the ledger; only settled rows are trimmed.
    const pending = (edit: (typeof state.clipEdits)[number]) =>
      edit.by === "agent" && !edit.accepted;
    const kept = new Set(
      state.clipEdits.filter((edit) => !pending(edit)).slice(-200),
    );
    state.clipEdits = state.clipEdits.filter(
      (edit) => pending(edit) || kept.has(edit),
    );
    await writeState(project, state);
  };

  type AssetSnapshot = Map<
    string,
    Awaited<ReturnType<typeof compositionVersions>>
  >;
  const assetSnapshots = new Map<string, AssetSnapshot>();
  const readAssets = async (project: Project): Promise<AssetSnapshot> => {
    const snapshot: AssetSnapshot = new Map();
    const directories = [""];
    for (const directory of directories) {
      for (const entry of await readdir(`${project.path}/${directory}`, {
        withFileTypes: true,
      })) {
        if (
          entry.name.startsWith(".") ||
          ["node_modules", "renders"].includes(entry.name)
        )
          continue;
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) directories.push(path);
        else if (entry.isFile() && /\.html?$/i.test(entry.name))
          snapshot.set(path, await compositionVersions(project, path));
      }
    }
    return snapshot;
  };
  const recordAssets = async (
    project: Project,
    before: AssetSnapshot,
    after: AssetSnapshot,
    actor: Extract<ReviewActor, { kind: "agent" }> | undefined,
  ) => {
    if (!actor) return;
    const changes = [...after].flatMap(([path, next]) => {
      const previous = before.get(path);
      if (!previous) return [];
      // A reference being authored is a source edit. Compare files already referenced before
      // this revision, so owner source edits cannot turn into agent asset replacements.
      const changed = new Set(
        [...next.references]
          .filter(([, paths]) =>
            [...paths].some(
              (path) =>
                previous.mediaFiles.has(path) &&
                next.mediaFiles.has(path) &&
                previous.mediaFiles.get(path) !== next.mediaFiles.get(path),
            ),
          )
          .map(([id]) => id),
      );
      return changed.size ? [{ path, previous, next, changed }] : [];
    });
    if (!changes.length) return;
    const pending = (await currentEdits(project)).filter(
      (edit) => edit.by === "agent" && !edit.accepted && !edit.resolution,
    );
    await (await store.history(project)).checkpoint();
    const items = await reconcile(project);
    const noteIds = items
      .filter(
        (item) =>
          item.review.status === "working" &&
          item.review.turnId === actor.turn.id,
      )
      .map((item) => item.id);
    for (const { path, previous, next, changed } of changes)
      await recordEdits(
        project,
        path,
        previous.versions,
        next.versions,
        changed,
        actor,
        noteIds,
        pending,
      );
  };
  const observeAssets = (project: Project) => {
    const turn = turns.get(project.id);
    const actor = turn ? { kind: "agent" as const, turn } : undefined;
    return serialize(project, async () => {
      const after = await readAssets(project);
      const before = assetSnapshots.get(project.id);
      if (before) await recordAssets(project, before, after, actor);
      assetSnapshots.set(project.id, after);
    });
  };

  const clipChanges = async (project: Project, composition: string) => {
    try {
      await reconcile(project);
      const path = posix.normalize(composition.replaceAll("\\", "/"));
      const edits = await currentEdits(project);
      const clipEdits = edits.filter((edit) => edit.composition === path);
      // Another file's clip bytes belong to a composition row in this view. Keep one
      // row per history entry and file, choosing pending work so it cannot be hidden.
      const compositions = new Map<string, (typeof edits)[number]>();
      for (const edit of edits) {
        if (edit.composition === path) continue;
        const key = JSON.stringify([
          edit.historyId ?? edit.id,
          edit.composition,
        ]);
        const previous = compositions.get(key);
        if (
          !previous ||
          (edit.by === "agent" && !edit.accepted && !edit.resolution)
        )
          compositions.set(key, {
            ...edit,
            clipId: null,
            label: `Edited ${edit.composition} composition`,
          });
      }
      clipEdits.push(...compositions.values());
      return {
        clipEdits,
        agentChanges: [
          ...new Set(
            clipEdits
              .filter(
                (edit) =>
                  edit.by === "agent" && !edit.accepted && !edit.resolution,
              )
              .flatMap((edit) =>
                edit.clipId === null || edit.composition !== path
                  ? []
                  : [edit.clipId],
              ),
          ),
        ],
      };
    } catch (error) {
      if (error instanceof ReviewFileError)
        return { clipEdits: [], agentChanges: [] };
      throw error;
    }
  };

  return {
    agent,
    authorize,
    observeAssets,
    /** API asset writers retain their request identity even during an agent turn. */
    editAssets: <T>(
      project: Project,
      token: string | undefined,
      work: () => Promise<T>,
    ) =>
      serialize(project, async () => {
        authorize(token, project.id);
        const before = await readAssets(project);
        const previous = assetSnapshots.get(project.id);
        const turn = turns.get(project.id);
        if (previous)
          await recordAssets(
            project,
            previous,
            before,
            turn ? { kind: "agent", turn } : undefined,
          );
        const result = await work();
        const after = await readAssets(project);
        await recordAssets(
          project,
          before,
          after,
          token === undefined ? undefined : agent(project, token),
        );
        assetSnapshots.set(project.id, after);
        return result;
      }),
    /** Source and timeline edits share the review queue, so accepting cannot race attribution. */
    editComposition: <T>(
      project: Project,
      composition: string,
      token: string | undefined,
      work: () => Promise<T>,
      noteId?: string,
    ) =>
      serialize(project, async () => {
        authorize(token, project.id);
        await projectWritePath(project, composition);
        composition = posix.normalize(composition.replaceAll("\\", "/"));
        let items: ReviewItem[];
        let before: ClipVersions;
        try {
          items = await reconcile(project);
          before = await clipVersions(project, composition);
        } catch (error) {
          // Broken review metadata cannot stop repairing source or using the timeline.
          if (
            error instanceof ReviewFileError ||
            error instanceof ProjectDocumentError
          )
            return work();
          throw error;
        }
        const actor = token === undefined ? undefined : agent(project, token);
        const claimed = actor
          ? items.filter(
              (item) =>
                item.review.status === "working" &&
                item.review.turnId === actor.turn.id,
            )
          : [];
        if (noteId !== undefined && !claimed.some((item) => item.id === noteId))
          throw new HttpError(
            409,
            "The edit's note must be claimed by this run.",
          );
        if (claimed.length > 1 && noteId === undefined)
          throw new HttpError(
            409,
            "Pass noteId to identify which claimed note this edit addresses.",
          );
        const noteIds =
          noteId === undefined ? claimed.map((item) => item.id) : [noteId];
        const pendingRows = (await currentEdits(project)).filter(
          (edit) => edit.by === "agent" && !edit.accepted && !edit.resolution,
        );
        const result = await work();
        const after = await clipVersions(project, composition);
        const changed = new Set(
          [...before.keys(), ...after.keys()].filter(
            (id) => before.get(id) !== after.get(id),
          ),
        );
        if (!changed.size) return result;
        await recordEdits(
          project,
          composition,
          before,
          after,
          changed,
          actor,
          noteIds,
          pendingRows,
        );
        return result;
      }),
    clipChanges: (project: Project, composition: string) =>
      serialize(project, () => clipChanges(project, composition)),
    /** The projection and its attribution must describe the same admitted source edits. */
    readComposition: <T extends object>(
      project: Project,
      composition: string,
      read: () => Promise<T>,
    ) =>
      serialize(project, async () => ({
        ...(await read()),
        ...(await clipChanges(project, composition)),
      })),
    acceptChanges: (project: Project, editId?: string) =>
      serialize(project, async () => {
        await reconcile(project);
        const edits = await currentEdits(project);
        const pending = edits.filter(
          (edit) => edit.by === "agent" && !edit.accepted && !edit.resolution,
        );
        // Another surface may have accepted it first; accepting twice is the same outcome.
        if (edits.some((edit) => edit.id === editId && edit.accepted)) return;
        if (editId !== undefined && !pending.some((edit) => edit.id === editId))
          throw new HttpError(409, "This change is no longer pending review.");
        const ids = new Set(
          pending
            .filter((edit) => editId === undefined || edit.id === editId)
            .map((edit) => edit.id),
        );
        const state = await readState(project);
        await writeState(project, {
          ...state,
          clipEdits: acceptEdits(state.clipEdits, ids),
        });
      }),
    /** Waits for in-flight review changes, so a read never shows an undo half done. */
    list: (project: Project) => serialize(project, () => reconcile(project)),
    /** An attachment may arrive after the note was sent, accepted, or undone. It changes no request. */
    attachFrame: (project: Project, id: string, framePath: string) =>
      serialize(project, async () => {
        await reconcile(project);
        const state = await readState(project);
        if (!state.items.some((item) => item.id === id))
          throw new HttpError(404, "Review note not found.");
        await writeState(project, {
          ...state,
          items: state.items.map((item) =>
            item.id === id ? { ...item, framePath } : item,
          ),
        });
      }),
    async act(
      project: Project,
      id: string,
      action: ReviewAction,
      actor: ReviewActor,
    ) {
      const stamped =
        action.type === "complete" && action.revision === undefined
          ? {
              ...action,
              revision: store.readHistory(project).list().at(-1)?.id,
            }
          : action;
      const items = await update(project, (items, document) => {
        const {
          review: _review,
          instructions: _instructions,
          ...request
        } = find(items, id);
        const found = document.annotations.find(
          (annotation) => annotation.id === id,
        );
        // Restoring re-queues what was sent, so the live note must match it again.
        if (stamped.type === "restore") {
          const { status: _status, ...content } = found ?? {};
          if (!found || !sameContent(content, request))
            throw new HttpError(
              409,
              "This note's content was removed or changed. Redo it before restoring the request.",
            );
        }
        return items.map((item) =>
          item.id === id
            ? { ...item, ...transition(item, stamped, actor) }
            : item,
        );
      });
      return find(items, id);
    },
    reorder: (
      project: Project,
      noteId: string,
      beforeId: string | null,
      actor: ReviewActor,
    ) =>
      update(project, (items) => {
        if (actor.kind === "agent" && actor.turn.kind !== "external")
          throw new HttpError(409, "Only the owner can reorder the queue.");
        const item = find(items, noteId);
        if (!unfinishedStatuses.some((status) => status === item.review.status))
          throw new HttpError(409, "Only unfinished notes can be reordered.");
        if (noteId === beforeId) return items;
        if (
          beforeId !== null &&
          !unfinishedStatuses.some(
            (status) => status === find(items, beforeId).review.status,
          )
        )
          throw new HttpError(409, "Move before an unfinished note.");
        const rest = items.filter((candidate) => candidate.id !== noteId);
        const at =
          beforeId === null
            ? rest.length
            : rest.findIndex((candidate) => candidate.id === beforeId);
        return [...rest.slice(0, at), item, ...rest.slice(at)];
      }),
    /** An agent's new request skips the draft state: it is already part of the work queue. */
    add: (
      project: Project,
      input: z.output<typeof ReviewAddSchema>,
      token: string | undefined,
    ) =>
      serialize(project, async () => {
        // Checked in the queue, so the run cannot end between the check and the add.
        agent(project, token);
        const annotation = await addAnnotation(
          store,
          project,
          AnnotationInputSchema.parse({ ...input, kind: "comment" }),
        );
        const items = await reconcile(project, outside, (items) =>
          items.map((item) =>
            item.id === annotation.id
              ? {
                  ...item,
                  review: { status: "queued", updatedAt: annotation.createdAt },
                }
              : item,
          ),
        );
        return find(items, annotation.id);
      }),
    edit: (
      project: Project,
      id: string,
      patch: z.output<typeof AnnotationPatchSchema>,
    ) =>
      changeDraft(project, id, "Update comment", (annotations, index) =>
        annotations.map((annotation, at) =>
          at === index
            ? { ...annotation, ...patch, updatedAt: new Date().toISOString() }
            : annotation,
        ),
      ),
    remove: (project: Project, id: string) =>
      changeDraft(project, id, "Remove comment", (annotations, index) =>
        annotations.filter((_annotation, at) => at !== index),
      ),
    /**
     * The project's history as seen by `actor`. Undo, redo, and restore run in the review queue,
     * reconciled before (so earlier outside edits keep their own cause) and after, so any sent note
     * they remove or change becomes withdrawn, credited to `actor`.
     */
    history(project: Project, history: ProjectHistory, actor: ReviewActor) {
      // History is how an unreadable cutroom.json gets repaired, so that alone never blocks it.
      // The saved review state is kept and reconciled once the document can be read again.
      const unlessUnreadable = (error: unknown) => {
        if (!(error instanceof ProjectDocumentError)) throw error;
      };
      const guarded = <T>(
        how: string,
        paths: () => string[],
        change: () => Promise<T>,
      ) =>
        serialize(project, async () => {
          await reconcile(project).catch(unlessUnreadable);
          await history.checkpoint();
          for (const path of paths()) {
            // History also owns these fixed app sidecars, never native agent configuration.
            if (
              [
                ...STUDIO_SIGNATURE_MANIFEST_PATHS,
                ".media/manifest.jsonl",
              ].includes(path)
            ) {
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
          const result = await change();
          await reconcile(project, { actor, how }).catch(unlessUnreadable);
          return result;
        });
      const overrides: Partial<ProjectHistory> = {
        step: (direction, who, options) =>
          guarded(
            direction === "back" ? "by undo" : "by redo",
            () =>
              history.next(direction, who)?.files.map((file) => file.path) ??
              [],
            () => history.step(direction, who, options),
          ),
        undo: (id, options) =>
          guarded(
            "by undo",
            () => {
              const entries = history.list();
              const index = entries.findIndex((entry) => entry.id === id);
              if (index < 0) return [];
              const selected =
                options.mode === "back-to-before"
                  ? entries.slice(index)
                  : [entries[index]!];
              return selected.flatMap((entry) =>
                entry.files.map((file) => file.path),
              );
            },
            () => history.undo(id, options),
          ),
        restore: (point, who, options) =>
          guarded(
            "by restoring an earlier version",
            () => {
              const target = history.peek(point);
              if (!target) return [];
              const current =
                history.peek(history.list().at(-1)?.id ?? "start") ?? {};
              return [
                ...new Set([...Object.keys(target), ...Object.keys(current)]),
              ].filter((path) => target[path] !== current[path]);
            },
            () => history.restore(point, who, options),
          ),
      };
      return new Proxy(history, {
        get(target, key) {
          if (key === "step" || key === "undo" || key === "restore")
            return overrides[key];
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    /**
     * Posting a message queues the owner's new notes and returns the digest the agent reconciles first.
     * Call `end` when the run finishes, fails, or is cancelled so its claimed notes return to the queue.
     */
    async beginTurn(project: Project, turn: ReviewTurn) {
      if (turns.has(project.id))
        throw new HttpError(
          409,
          "A conversation in this project is already working. Stop it or wait for it to finish.",
        );
      const baseline = observeAssets(project);
      turns.set(project.id, turn);
      let ended = false;
      const end = async () => {
        if (ended) return;
        ended = true;
        const observed = observeAssets(project);
        if (turns.get(project.id) === turn) turns.delete(project.id);
        try {
          await observed;
        } finally {
          await update(project, (items) => items);
        }
      };
      const human: ReviewActor = { kind: "human" };
      try {
        await baseline;
        const items = await update(project, (items) =>
          items.map((item) =>
            item.review.status === "open"
              ? { ...item, ...transition(item, { type: "send" }, human) }
              : item,
          ),
        );
        return { digest: reviewDigest(project, items), end };
      } catch (error) {
        if (error instanceof ReviewFileError)
          return {
            digest: `Review notes are unavailable: ${error.message} Do not change review status this turn.`,
            end,
          };
        ended = true;
        turns.delete(project.id);
        throw error;
      }
    },
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;

function oneLine(value: string, limit = 160) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** A compact view of every unfinished note, sent with each message so earlier requests are never forgotten. */
export function reviewDigest(project: Project, items: ReviewItem[]) {
  const unfinished = items.filter((item) =>
    unfinishedStatuses.some((status) => status === item.review.status),
  );
  if (!unfinished.length) return null;
  const lines = unfinished.map((item, index) => {
    const where = [
      `${item.time.toFixed(2)}s`,
      item.endTime !== undefined && `to ${item.endTime.toFixed(2)}s`,
      item.compositionPath,
      item.elementId && `#${item.elementId}`,
      item.framePath && `frame ${item.framePath}`,
    ]
      .filter(Boolean)
      .join(" ");
    const review = item.review;
    const details = [
      ...item.instructions.map(
        (instruction) => `Owner added: ${oneLine(instruction.text)}`,
      ),
      review.status === "blocked" && `You asked: ${oneLine(review.question)}`,
      review.status === "done" &&
        `You noted: ${oneLine(review.note)} Awaiting the owner's review.`,
    ].filter((detail) => detail !== false);
    return [
      `${index + 1}. [${review.status}] ${item.id} · ${item.kind} at ${where} · "${oneLine(item.body)}"`,
      ...details.map((detail) => `   ${detail}`),
    ].join("\n");
  });
  return [
    `Review queue for project ${project.id}: ${unfinished.length} unfinished ${unfinished.length === 1 ? "note" : "notes"} in the owner's order.`,
    ...lines,
    "Reconcile this message with the queue before anything else. Newer intent wins: when the message cancels or replaces a note, call review_withdraw with a short reason instead of doing it (for a replacement, add the new request with review_add and pass its ID as replacedBy). If the message answers a blocked note, call review_claim with that answer and continue. Then work through the queued notes in order: review_claim when you start one, review_complete with a short note when it is finished, and review_block with a question when you need the owner. Notes you do not finish stay queued; never drop one silently. Use review_list for drawings and full detail.",
  ].join("\n");
}

/** Compares note content regardless of key order, as saved by different files. */
function sameContent(a: object, b: object) {
  const canonical = (value: object) =>
    JSON.stringify(value, (_key, inner: unknown) =>
      inner && typeof inner === "object" && !Array.isArray(inner)
        ? Object.fromEntries(
            Object.entries(inner).sort(([x], [y]) => x.localeCompare(y)),
          )
        : inner,
    );
  return canonical(a) === canonical(b);
}
