import { useEffect, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowUpRight,
  ChatTeardropText,
  PencilSimple,
  Queue,
  Trash,
  X,
} from "@phosphor-icons/react";
import { z } from "zod";
import type { EditorReviewDraft } from "../../shared/editor";
import type {
  HumanReviewActionSchema,
  ReviewItem,
  ReviewStatus,
} from "../../shared/review";
import { FpsSchema } from "../../shared/timeline/schema";
import { api, frameTimecode } from "../api";
import { useFps } from "../workspace";
import { Modal } from "./Modal";

type HumanAction = z.input<typeof HumanReviewActionSchema>;
/** A question stalls the agent, so blocked notes lead To review. */
const groups = [
  ["New", ["open"]],
  ["In progress", ["working"]],
  ["To review", ["blocked", "done"]],
  ["Queued", ["queued"]],
  ["Accepted", ["accepted"]],
  ["Withdrawn", ["withdrawn"]],
] as const satisfies ReadonlyArray<
  readonly [string, ReadonlyArray<ReviewStatus>]
>;
const timelineFpsSchema = z.object({
  timeline: z.object({ fps: FpsSchema }),
});

/** `index.html#title-card` reads as "Title card". */
function elementName(id: string) {
  const name = id.split("#").at(-1)?.replace(/[-_]+/g, " ").trim() ?? "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function instructionText(instruction: ReviewItem["instructions"][number]) {
  return `${
    instruction.source === "chat"
      ? "You answered in chat: "
      : instruction.by === "external"
        ? "An outside agent added for you: "
        : "You added: "
  }${instruction.text}`;
}

/** The agent's answer, question, or withdrawal, when the note has one. */
function agentWord({ review }: ReviewItem) {
  if (review.status === "blocked") return `Agent asks: ${review.question}`;
  if (review.status === "done") return review.note;
  if (review.status !== "withdrawn") return null;
  return `${
    {
      human: "You withdrew it: ",
      agent: "Agent withdrew it: ",
      external: "An outside agent withdrew it: ",
    }[review.by]
  }${review.reason}`;
}

/** A row's last line: the agent's latest word, or else your latest instruction. */
function outcome(item: ReviewItem) {
  const instruction = item.instructions.at(-1);
  return agentWord(item) ?? (instruction ? instructionText(instruction) : null);
}

/**
 * Each note's timecode uses its own composition's frame rate, so opening another
 * composition never changes it. Unknown rates show no timecode rather than a guess.
 */
function useNoteFps(projectId: string, items: ReviewItem[]) {
  const [rates, setRates] = useState(new Map<string, number | Error>());
  const paths = [...new Set(items.map((item) => item.compositionPath))];
  const missing = paths.filter((path) => !rates.has(path)).join("\n");
  useEffect(() => {
    if (!missing) return;
    let cancelled = false;
    for (const path of missing.split("\n"))
      void api(
        `/projects/${projectId}/timeline?composition=${encodeURIComponent(path)}`,
        timelineFpsSchema,
      )
        .then(
          ({ timeline: { fps } }) => fps.num / fps.den,
          // An unreadable composition shows no timecode rather than a guessed rate.
          (error: unknown) =>
            error instanceof Error ? error : new Error(String(error)),
        )
        .then((rate) => {
          if (!cancelled)
            setRates((current) => new Map(current).set(path, rate));
        });
    return () => {
      cancelled = true;
    };
  }, [projectId, missing]);
  return (item: ReviewItem) => rates.get(item.compositionPath);
}

function noteTimecode(item: ReviewItem, rate: number | Error | undefined) {
  return typeof rate === "number" ? frameTimecode(item.time, rate) : "";
}

export function ReviewPanel({
  projectId,
  items,
  reviewError,
  draft,
  onSave,
  onCancel,
  onSeek,
  onAct,
  onDelete,
  onSend,
}: {
  projectId: string;
  items: ReviewItem[];
  reviewError?: string;
  draft: EditorReviewDraft | null;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
  onSeek: (item: ReviewItem) => void;
  onAct: (item: ReviewItem, action: HumanAction) => Promise<void>;
  onDelete: (item: ReviewItem) => Promise<void>;
  onSend: () => void;
}) {
  const draftFps = useFps();
  const noteFps = useNoteFps(projectId, items);
  const [body, setBody] = useState("");
  const [savingDraft, setSavingDraft] = useState<EditorReviewDraft | null>(
    null,
  );
  const saving = draft !== null && savingDraft === draft;
  const activeDraft = useRef(draft);
  activeDraft.current = draft;
  const [error, setError] = useState("");
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const details = items.find((item) => item.id === detailsId);
  const [answer, setAnswer] = useState<{
    id: string;
    type: "reject" | "reply";
    note: string;
  } | null>(null);
  const answerOpener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => setBody(""), [draft]);
  const fresh = items.filter((item) => item.review.status === "open");
  const current = items.filter((item) => item.review.status !== "withdrawn");
  const accepted = items.filter((item) => item.review.status === "accepted");
  const number = new Map(items.map((item, index) => [item.id, index + 1]));
  const frameUrl = (path: string) =>
    `/api/cutroom/projects/${projectId}/attachments/${encodeURIComponent(path.split("/").at(-1) ?? "")}`;
  const timecode = (item: ReviewItem) => noteTimecode(item, noteFps(item));

  async function run(action: () => Promise<void>) {
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  function closeAnswer() {
    setAnswer(null);
    answerOpener.current?.focus();
  }

  function row(item: ReviewItem) {
    const status = item.review.status;
    const answering = answer?.id === item.id ? answer : null;
    const result = outcome(item);
    const open =
      (type: "reject" | "reply") =>
      (event: { currentTarget: HTMLButtonElement }) => {
        answerOpener.current = event.currentTarget;
        setAnswer({ id: item.id, type, note: "" });
      };
    return (
      <article className="review-row" data-status={status} key={item.id}>
        <span className="note-pin" data-status={status}>
          {number.get(item.id)}
        </span>
        <div className="review-row-text">
          <div className="review-row-meta">
            <button
              className="note-seek mono"
              title={(() => {
                const rate = noteFps(item);
                return rate instanceof Error
                  ? `Go to this moment. Its frame rate could not be read: ${rate.message}`
                  : "Go to this moment";
              })()}
              onClick={() => onSeek(item)}
            >
              {timecode(item)}
            </button>
            <span className="note-element">
              {item.elementId
                ? elementName(item.elementId)
                : item.kind === "drawing"
                  ? "Drawing"
                  : "Comment"}
            </span>
            <div className="review-row-actions">
              {status === "withdrawn" && (
                <button
                  className="icon-button"
                  aria-label="Restore to queue"
                  title="Restore to queue"
                  onClick={() =>
                    void run(() => onAct(item, { type: "restore" }))
                  }
                >
                  <ArrowCounterClockwise />
                </button>
              )}
              {status === "working" && (
                <button
                  className="icon-button"
                  aria-label="Return to queue"
                  title="Return to queue"
                  onClick={() =>
                    void run(() => onAct(item, { type: "release" }))
                  }
                >
                  <Queue />
                </button>
              )}
              {status !== "open" &&
                status !== "withdrawn" &&
                status !== "accepted" && (
                  <button
                    className="icon-button"
                    aria-label="Withdraw"
                    title="Withdraw"
                    onClick={() =>
                      void run(() =>
                        onAct(item, {
                          type: "withdraw",
                          reason: "Withdrawn in Review.",
                        }),
                      )
                    }
                  >
                    <X />
                  </button>
                )}
              {status === "open" && (
                <button
                  className="icon-button"
                  aria-label="Delete note"
                  title="Delete"
                  onClick={() => void run(() => onDelete(item))}
                >
                  <Trash />
                </button>
              )}
            </div>
          </div>
          <p className="review-row-body" title={item.body}>
            {item.body}
          </p>
          {status === "done" && (
            <div className="review-row-decide">
              <button
                className="text-button"
                onClick={() => void run(() => onAct(item, { type: "accept" }))}
              >
                Accept
              </button>
              <button className="text-button quiet" onClick={open("reject")}>
                Reject
              </button>
            </div>
          )}
          {status === "blocked" && (
            <div className="review-row-decide">
              <button className="text-button" onClick={open("reply")}>
                Answer
              </button>
            </div>
          )}
        </div>
        <button
          className="note-thumb"
          aria-label={item.framePath ? "View annotated frame" : "View note"}
          title="Note details"
          onClick={() => setDetailsId(item.id)}
        >
          {item.framePath ? (
            <img
              loading="lazy"
              src={frameUrl(item.framePath)}
              alt={`Annotated frame at ${timecode(item)}`}
            />
          ) : (
            <ChatTeardropText size={14} />
          )}
        </button>
        {result && (
          <p className="review-row-outcome" title={result}>
            {result}
          </p>
        )}
        {answering && (
          <form
            className="review-answer"
            onSubmit={(event) => {
              event.preventDefault();
              if (!answering.note.trim()) return;
              void run(async () => {
                await onAct(item, {
                  type: answering.type,
                  note: answering.note,
                });
                setAnswer(null);
              });
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              closeAnswer();
            }}
          >
            <textarea
              autoFocus
              aria-label={
                answering.type === "reply"
                  ? "Answer the agent"
                  : "What still needs to change?"
              }
              placeholder={
                answering.type === "reply"
                  ? "Your answer"
                  : "What still needs to change?"
              }
              value={answering.note}
              onChange={(event) =>
                setAnswer({ ...answering, note: event.target.value })
              }
              rows={2}
            />
            <div>
              <button
                type="button"
                className="secondary-button"
                onClick={closeAnswer}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={!answering.note.trim()}
              >
                {answering.type === "reply" ? "Reply" : "Send back"}
              </button>
            </div>
          </form>
        )}
      </article>
    );
  }

  return (
    <section className="review-panel" aria-label="Review notes">
      {current.length > 0 && (
        <div className="review-summary">
          {current.length} {current.length === 1 ? "note" : "notes"},{" "}
          {accepted.length} accepted
        </div>
      )}
      {draft && (
        <form
          className="review-draft"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft || !body.trim() || saving) return;
            const submittedDraft = draft;
            setSavingDraft(submittedDraft);
            void run(async () => {
              await onSave(body);
              if (activeDraft.current === submittedDraft) setBody("");
            }).finally(() =>
              setSavingDraft((current) =>
                current === submittedDraft ? null : current,
              ),
            );
          }}
        >
          <div className="review-draft-heading">
            <span>
              {draft.kind === "draw" ? <PencilSimple /> : <ChatTeardropText />}
              Note at{" "}
              <span className="mono">
                {frameTimecode(draft.time, draftFps)}
              </span>
            </span>
            <button
              className="icon-button"
              type="button"
              aria-label="Cancel note"
              onClick={onCancel}
            >
              <X />
            </button>
          </div>
          <div className="annotation-frame">
            <img src={draft.frameUrl} alt="Frame for this note" />
            {draft.kind === "draw" && (
              <svg
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <polyline
                  points={draft.points
                    .map((point) => `${point.x},${point.y}`)
                    .join(" ")}
                />
              </svg>
            )}
          </div>
          <label className="sr-only" htmlFor="review-body">
            What should change?
          </label>
          <textarea
            id="review-body"
            autoFocus
            disabled={saving}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="What should change here?"
            rows={3}
          />
          <button className="primary-button" disabled={!body.trim() || saving}>
            {saving ? "Saving…" : "Add note"}
          </button>
        </form>
      )}
      {(error || reviewError) && (
        <p className="inline-error" role="alert">
          {error || reviewError}
        </p>
      )}
      {items.length === accepted.length && !draft && !reviewError && (
        <div className="small-empty">
          <ChatTeardropText size={25} weight="light" />
          <h3>Start with what you see.</h3>
          <p>
            Draw on the picture or pin a comment. Each note stays in the queue
            until it is done or withdrawn.
          </p>
        </div>
      )}
      {groups.map(([title, statuses]) => {
        const members = statuses.flatMap((status) =>
          items.filter((item) => item.review.status === status),
        );
        if (!members.length) return null;
        return (
          <section
            className="review-group"
            key={title}
            aria-label={`${title} notes`}
          >
            <h3>{title}</h3>
            {members.map(row)}
            {title === "New" && (
              <div className="review-send">
                <button className="secondary-button" onClick={onSend}>
                  Use {fresh.length} {fresh.length === 1 ? "note" : "notes"} in
                  chat
                  <ArrowUpRight size={15} />
                </button>
              </div>
            )}
          </section>
        );
      })}
      {details && (
        <Modal
          title={
            <>
              Review at <span className="mono">{timecode(details)}</span>
            </>
          }
          onClose={() => setDetailsId(null)}
          wide={Boolean(details.framePath)}
        >
          {details.framePath && (
            <img
              className="review-full-frame"
              src={frameUrl(details.framePath)}
              alt={details.body}
            />
          )}
          <div className="review-full-note">
            <p>{details.body}</p>
            {details.instructions.length > 0 && (
              <ol className="review-history" aria-label="Your instructions">
                {details.instructions.map((instruction) => (
                  <li key={instruction.at}>{instructionText(instruction)}</li>
                ))}
              </ol>
            )}
            {agentWord(details) && (
              <p className="review-full-outcome">{agentWord(details)}</p>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
