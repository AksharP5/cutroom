import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { AnnotationInputSchema } from "../../shared/project";
import type {
  Annotation,
  Project,
  ProjectDocument,
} from "../../shared/project";
import {
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

/** Outside project history and the editor's preview watcher, so status changes are never undone. */
export const REVIEW_STATE_PATH = ".cutroom/review.json";
const ReviewFileSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(ReviewStateSchema.extend({ id: z.string() })),
});
type ReviewFile = z.infer<typeof ReviewFileSchema>;

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

export function createReviewService(store: ProjectStore) {
  const turns = new Map<string, ReviewTurn>();
  const queues = new Map<string, Promise<unknown>>();
  // Outside MCP clients act in this server's lifetime; their claims return to the queue after a restart.
  const external: ReviewTurn = {
    id: `external:${randomUUID()}`,
    kind: "external",
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

  /** Joins undoable note content with review state in the owner's order. */
  const join = (
    project: Project,
    state: ReviewFile,
    document: ProjectDocument,
  ): ReviewItem[] => {
    const live = [external.id, turns.get(project.id)?.id];
    const stored = new Map(state.items.map((item) => [item.id, item]));
    const annotations = new Map(
      document.annotations.map((annotation) => [annotation.id, annotation]),
    );
    const ordered = [
      ...state.items.flatMap((item) => annotations.get(item.id) ?? []),
      ...document.annotations.filter(
        (annotation) => !stored.has(annotation.id),
      ),
    ];
    return ordered.map(({ status, ...content }) => {
      const current = stored.get(content.id) ?? {
        review: migrateLegacyStatus(status, content.updatedAt),
        instructions: [],
      };
      // A claim whose run has ended (finished, crashed, or a previous server) returns to the queue.
      const stale =
        current.review.status === "working" &&
        !live.includes(current.review.turnId);
      return {
        ...content,
        ...(stale
          ? transition(
              current,
              { type: "release" },
              { kind: "agent", turn: external },
            )
          : { review: current.review, instructions: current.instructions }),
      };
    });
  };

  /** Statuses now live in review.json, so the copies saved in older `cutroom.json` files go. */
  const removeLegacyStatus = (project: Project) =>
    store
      .mutate(project, "Move review status out of cutroom.json", async () => {
        const document = await store.document(project);
        if (!document.annotations.some((annotation) => annotation.status))
          return;
        document.annotations = document.annotations.map(
          ({ status: _status, ...annotation }) => annotation,
        );
        await store.writeDocument(project, document);
      })
      .catch((error: unknown) =>
        console.error("Legacy review status stays in cutroom.json:", error),
      );

  /** Serializes read-change-write per project so concurrent transitions cannot overwrite each other. */
  const update = (
    project: Project,
    change: (items: ReviewItem[]) => ReviewItem[],
  ): Promise<ReviewItem[]> => {
    const previous = queues.get(project.id) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(async () => {
        const [state, document] = await Promise.all([
          readState(project),
          store.document(project),
        ]);
        const next = change(join(project, state, document));
        const visible = new Set(next.map((item) => item.id));
        const written: ReviewFile = {
          schemaVersion: 1,
          items: [
            ...next.map(({ id, review, instructions }) => ({
              id,
              review,
              instructions,
            })),
            // Notes removed by undo keep their status in case redo brings them back.
            ...state.items.filter((item) => !visible.has(item.id)),
          ],
        };
        if (JSON.stringify(written) !== JSON.stringify(state))
          await writeState(project, written);
        if (document.annotations.some((annotation) => annotation.status))
          await removeLegacyStatus(project);
        return next;
      });
    queues.set(project.id, pending);
    void pending
      .catch(() => undefined)
      .then(() => {
        if (queues.get(project.id) === pending) queues.delete(project.id);
      });
    return pending;
  };

  const actor = (project: Project, kind: ReviewActor["kind"]): ReviewActor =>
    kind === "human"
      ? { kind }
      : { kind, turn: turns.get(project.id) ?? external };

  return {
    list: async (project: Project, document: ProjectDocument) =>
      join(project, await readState(project), document),
    async act(
      project: Project,
      id: string,
      action: ReviewAction,
      kind: ReviewActor["kind"],
    ) {
      const stamped =
        action.type === "complete" && action.revision === undefined
          ? {
              ...action,
              revision: (await store.history(project)).list().at(-1)?.id,
            }
          : action;
      const items = await update(project, (items) => {
        find(items, id);
        return items.map((item) =>
          item.id === id
            ? { ...item, ...transition(item, stamped, actor(project, kind)) }
            : item,
        );
      });
      return find(items, id);
    },
    /** An agent's new request skips the draft state: it is already part of the work queue. */
    async add(project: Project, input: z.output<typeof ReviewAddSchema>) {
      const annotation = await addAnnotation(
        store,
        project,
        AnnotationInputSchema.parse({ ...input, kind: "comment" }),
      );
      const items = await update(project, (items) =>
        items.map((item) =>
          item.id === annotation.id && item.review.status === "open"
            ? {
                ...item,
                review: { status: "queued", updatedAt: annotation.createdAt },
              }
            : item,
        ),
      );
      return find(items, annotation.id);
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
    "Reconcile this message with the queue before anything else. Newer intent wins: when the message cancels or replaces a note, call review_withdraw with a short reason instead of doing it (for a replacement, add the new request with review_add and pass its ID as replacedBy). If the message answers a blocked note, claim it and continue. Then work through the queued notes in order: review_claim when you start one, review_complete with a short note when it is finished, and review_block with a question when you need the owner. Notes you do not finish stay queued; never drop one silently. Use review_list for drawings and full detail.",
  ].join("\n");
}
