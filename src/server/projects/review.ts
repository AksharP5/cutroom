import { randomUUID } from "node:crypto";
import type { ProjectHistory } from "@hyperframes/studio-server";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
import { isMissing, projectPath } from "./store";
import type { ProjectStore } from "./store";

const ReviewFileSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(
    ReviewStateSchema.extend({
      id: z.string(),
      // What was submitted, so a request survives its content being undone.
      content: NoteContentSchema.optional(),
    }),
  ),
});
type ReviewFile = z.infer<typeof ReviewFileSchema>;
/** Who changed a sent note's content, and how: "by undo", "outside Cutroom", and so on. */
type Cause = { actor: ReviewActor; how: string };

/** Review status is unreadable. Only review actions stop; transcripts and chat keep working. */
export class ReviewFileError extends HttpError {
  constructor() {
    super(
      422,
      `Review status in ${REVIEW_STATE_PATH} is unreadable. Repair the file to keep reviewing; no note changes status until then.`,
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
      const now = new Date().toISOString();
      const annotation = {
        ...input,
        id: randomUUID(),
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
    const raw = await projectPath(project, REVIEW_STATE_PATH, true)
      .then((path) => readFile(path, "utf8"))
      .catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
    if (raw === null) return { schemaVersion: 1, items: [] };
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ReviewFileError();
    }
    const parsed = ReviewFileSchema.safeParse(json);
    if (!parsed.success) throw new ReviewFileError();
    return parsed.data;
  };

  const writeState = async (project: Project, state: ReviewFile) => {
    await mkdir(await projectPath(project, ".cutroom", true), {
      recursive: true,
    });
    const path = await projectPath(project, REVIEW_STATE_PATH, true);
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
    const [state, document] = await Promise.all([
      readState(project),
      store.document(project),
    ]);
    const live = [external.id, turns.get(project.id)?.id];
    const annotations = new Map(
      document.annotations.map(({ status, ...content }) => [
        content.id,
        { content, status },
      ]),
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
    const next = change(items, document);
    const visible = new Set(next.map((item) => item.id));
    const written: ReviewFile = {
      schemaVersion: 1,
      items: [
        ...next.map(({ review, instructions, ...content }) => ({
          id: content.id,
          review,
          instructions,
          ...(review.status !== "open" && { content }),
        })),
        // Drafts removed by undo keep their entry in case redo brings them back.
        ...state.items.filter((item) => !visible.has(item.id)),
      ],
    };
    if (JSON.stringify(written) !== JSON.stringify(state))
      await writeState(project, written);
    return next;
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

  return {
    /**
     * The agent behind a request. A conversation's token only acts on the project whose run it
     * belongs to, while that run is active; anything else is refused rather than guessed.
     */
    agent(project: Project, token: string | undefined): ReviewActor {
      if (token === undefined || token === "external")
        return { kind: "agent", turn: external };
      const turn = turns.get(project.id);
      if (turn?.kind !== "message" || turn.token !== token)
        throw new HttpError(409, "No Cutroom run is active for this project.");
      return { kind: "agent", turn };
    },
    /** Waits for in-flight review changes, so a read never shows an undo half done. */
    list: (project: Project) => serialize(project, () => reconcile(project)),
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
              revision: (await store.history(project)).list().at(-1)?.id,
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
    /** An agent's new request skips the draft state: it is already part of the work queue. */
    add: (project: Project, input: z.output<typeof ReviewAddSchema>) =>
      serialize(project, async () => {
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
      const guarded = <T>(how: string, change: () => Promise<T>) =>
        serialize(project, async () => {
          await reconcile(project);
          const result = await change();
          await reconcile(project, { actor, how });
          return result;
        });
      const overrides: Partial<ProjectHistory> = {
        step: (direction, ...rest) =>
          guarded(direction === "back" ? "by undo" : "by redo", () =>
            history.step(direction, ...rest),
          ),
        undo: (...args) => guarded("by undo", () => history.undo(...args)),
        restore: (...args) =>
          guarded("by restoring an earlier version", () =>
            history.restore(...args),
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
      turns.set(project.id, turn);
      let ended = false;
      const end = async () => {
        if (ended) return;
        ended = true;
        if (turns.get(project.id) === turn) turns.delete(project.id);
        await update(project, (items) => items);
      };
      const human: ReviewActor = { kind: "human" };
      try {
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
