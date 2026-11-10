import { z } from "zod";
import { AnnotationSchema } from "./project";
import type { Annotation } from "./project";
import { HttpError } from "./errors";

const text = z.string().trim().min(1).max(4_000);
const updatedAt = z.string();

/**
 * Header Cutroom's MCP bridge adds to every request it forwards. A native agent's bridge
 * sends the server's agent token; any other MCP client sends `external`. Requests from the
 * Review panel carry no header.
 */
export const AGENT_HEADER = "x-cutroom-agent";

/** Outside project history and the preview watcher, so status changes are never undone. */
export const REVIEW_STATE_PATH = ".cutroom/review.json";

/**
 * One review note's lifecycle. A note stays in the queue until an explicit
 * transition finishes it; nothing moves it implicitly.
 */
export const ReviewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("open"), updatedAt }),
  z.object({ status: z.literal("queued"), updatedAt }),
  z.object({ status: z.literal("working"), updatedAt, turnId: z.string() }),
  z.object({
    status: z.literal("done"),
    updatedAt,
    note: text,
    revision: z.string().nullable(),
  }),
  z.object({
    status: z.literal("accepted"),
    updatedAt,
    note: text.optional(),
  }),
  z.object({ status: z.literal("blocked"), updatedAt, question: text }),
  z.object({
    status: z.literal("withdrawn"),
    updatedAt,
    reason: text,
    by: z.enum(["human", "agent", "external"]),
    messageId: z.string().optional(),
    replacedBy: z.string().optional(),
  }),
]);
export type Review = z.infer<typeof ReviewSchema>;
export type ReviewStatus = Review["status"];

/**
 * What the owner asked for after the note was written: a reply or send-back in Review,
 * or a chat answer the agent recorded when it resumed a blocked note. Kept through every
 * status change.
 */
export const InstructionSchema = z.object({
  text,
  at: z.string(),
  source: z.enum(["review", "chat"]),
  messageId: z.string().optional(),
});
export const ReviewStateSchema = z.object({
  review: ReviewSchema,
  instructions: z.array(InstructionSchema),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/** The run an agent acts in: the owner's message in Cutroom, or an outside MCP client. */
export type ReviewTurn = { id: string; kind: "message" | "external" };
export type ReviewActor =
  { kind: "human" } | { kind: "agent"; turn: ReviewTurn };

export const reviewActions = {
  send: z.object({ type: z.literal("send") }),
  claim: z.object({
    type: z.literal("claim"),
    answer: text
      .optional()
      .describe(
        "Required for a blocked note: the owner's answer from their message, as you read it",
      ),
  }),
  complete: z.object({
    type: z.literal("complete"),
    note: text.describe("What changed, in one or two sentences"),
    revision: z
      .string()
      .optional()
      .describe("History entry ID for the change. Defaults to the latest."),
  }),
  block: z.object({
    type: z.literal("block"),
    question: text.describe("What the owner must answer before you continue"),
  }),
  release: z.object({ type: z.literal("release") }),
  withdraw: z.object({
    type: z.literal("withdraw"),
    reason: text.describe("Why this request no longer applies"),
    replacedBy: z
      .string()
      .optional()
      .describe("ID of the note that replaces this one"),
  }),
  accept: z.object({ type: z.literal("accept") }),
  reject: z.object({ type: z.literal("reject"), note: text }),
  reply: z.object({ type: z.literal("reply"), note: text }),
  restore: z.object({ type: z.literal("restore") }),
};
export const ReviewActionSchema = z.discriminatedUnion("type", [
  reviewActions.send,
  reviewActions.claim,
  reviewActions.complete,
  reviewActions.block,
  reviewActions.release,
  reviewActions.withdraw,
  reviewActions.accept,
  reviewActions.reject,
  reviewActions.reply,
  reviewActions.restore,
]);
export const HumanReviewActionSchema = z.discriminatedUnion("type", [
  reviewActions.accept,
  reviewActions.reject,
  reviewActions.reply,
  reviewActions.restore,
  reviewActions.release,
  reviewActions.withdraw.omit({ replacedBy: true }),
]);
export const AgentReviewActionSchema = z.discriminatedUnion("type", [
  reviewActions.claim,
  reviewActions.complete,
  reviewActions.block,
  reviewActions.withdraw,
]);
export type ReviewAction = z.infer<typeof ReviewActionSchema>;

/** Statuses the agent still has to act on or the owner still has to review. */
export const unfinishedStatuses = [
  "open",
  "queued",
  "working",
  "blocked",
  "done",
] as const satisfies readonly ReviewStatus[];

type Rule = { readonly [K in ReviewActor["kind"]]?: readonly ReviewStatus[] };

/** Which states each actor may leave through each action. Anything absent is refused. */
const transitions = {
  send: { human: ["open"] },
  claim: { agent: ["open", "queued", "blocked"] },
  complete: { agent: ["open", "queued", "working", "blocked"] },
  block: { agent: ["queued", "working"] },
  release: { agent: ["working"], human: ["working"] },
  withdraw: {
    human: unfinishedStatuses,
    agent: ["queued", "working", "blocked", "done"],
  },
  accept: { human: ["done"] },
  reject: { human: ["done"] },
  reply: { human: ["blocked"] },
  restore: { human: ["withdrawn"] },
} as const satisfies Record<ReviewAction["type"], Rule>;

export function transition(
  { review, instructions }: ReviewState,
  next: ReviewAction,
  actor: ReviewActor,
  now = new Date().toISOString(),
): ReviewState {
  const rule: Rule = transitions[next.type];
  if (!rule[actor.kind]?.includes(review.status))
    throw new HttpError(
      409,
      `The ${actor.kind} cannot ${next.type} a note that is ${review.status}.`,
    );
  const turn = actor.kind === "agent" ? actor.turn : undefined;
  const messageId = turn?.kind === "message" ? turn.id : undefined;
  const to = (review: Review): ReviewState => ({ review, instructions });
  switch (next.type) {
    case "send":
    case "release":
    case "restore":
      return to({ status: "queued", updatedAt: now });
    case "reject":
    case "reply":
      return {
        review: { status: "queued", updatedAt: now },
        instructions: [
          ...instructions,
          { text: next.note, at: now, source: "review" },
        ],
      };
    case "claim": {
      if (!turn) throw new HttpError(409, "Only an agent can claim a note.");
      const working: Review = {
        status: "working",
        updatedAt: now,
        turnId: turn.id,
      };
      if (review.status !== "blocked") return to(working);
      // The owner answered in chat; keep that answer with the note so it is never lost.
      if (!next.answer)
        throw new HttpError(
          409,
          "Pass the owner's answer to claim a blocked note.",
        );
      return {
        review: working,
        instructions: [
          ...instructions,
          {
            text: next.answer,
            at: now,
            source: "chat",
            ...(messageId && { messageId }),
          },
        ],
      };
    }
    case "complete":
      return to({
        status: "done",
        updatedAt: now,
        note: next.note,
        revision: next.revision ?? null,
      });
    case "block":
      return to({ status: "blocked", updatedAt: now, question: next.question });
    case "accept":
      return to({
        status: "accepted",
        updatedAt: now,
        ...(review.status === "done" && { note: review.note }),
      });
    case "withdraw":
      return to({
        status: "withdrawn",
        updatedAt: now,
        reason: next.reason,
        by: turn?.kind === "external" ? "external" : actor.kind,
        ...(messageId && { messageId }),
        ...(next.replacedBy && { replacedBy: next.replacedBy }),
      });
  }
}

/** Notes saved before review state moved out of `cutroom.json` keep their meaning. */
export function migrateLegacyStatus(
  status: Annotation["status"],
  updatedAt: string,
): Review {
  if (status === "sent") return { status: "queued", updatedAt };
  if (status === "resolved") return { status: "accepted", updatedAt };
  return { status: "open", updatedAt };
}

export const NoteContentSchema = AnnotationSchema.omit({ status: true });
export const ReviewItemSchema = NoteContentSchema.extend(
  ReviewStateSchema.shape,
);
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

export const ReviewAddSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  time: z.number().finite().nonnegative().default(0),
  compositionPath: z.string().default("index.html"),
  elementId: z.string().max(200).optional(),
});
export const NotebookSchema = z.object({
  items: z.array(ReviewItemSchema),
  /** Set when `.cutroom/review.json` cannot be read; transcripts still load. */
  reviewError: z.string().optional(),
  transcriptVersion: z.string(),
});
export type Notebook = z.infer<typeof NotebookSchema>;
