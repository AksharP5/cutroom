import { useEffect, useRef, useState } from "react";
import {
  ArrowBendUpLeft,
  ArrowCounterClockwise,
  ArrowUpRight,
  ChatTeardropText,
  Check,
  PencilSimple,
  Queue,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { z } from "zod";
import type { EditorReviewDraft } from "../../shared/editor";
import type {
  HumanReviewActionSchema,
  ReviewItem,
  ReviewStatus,
} from "../../shared/review";
import { timecode } from "../api";
import { Modal } from "./Modal";

type HumanAction = z.input<typeof HumanReviewActionSchema>;
const groups = [
  ["open", "New"],
  ["blocked", "Needs your answer"],
  ["done", "Done"],
  ["working", "Working"],
  ["queued", "Queued"],
  ["withdrawn", "Withdrawn"],
] as const satisfies ReadonlyArray<readonly [ReviewStatus, string]>;

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
  const [body, setBody] = useState("");
  const [savingDraft, setSavingDraft] = useState<EditorReviewDraft | null>(
    null,
  );
  const saving = draft !== null && savingDraft === draft;
  const activeDraft = useRef(draft);
  activeDraft.current = draft;
  const [error, setError] = useState("");
  const [frame, setFrame] = useState<ReviewItem | null>(null);
  const [answer, setAnswer] = useState<{
    id: string;
    type: "reject" | "reply";
    note: string;
  } | null>(null);
  useEffect(() => setBody(""), [draft]);
  const fresh = items.filter((item) => item.review.status === "open");
  const accepted = items.filter((item) => item.review.status === "accepted");
  const number = new Map(items.map((item, index) => [item.id, index + 1]));

  async function run(action: () => Promise<void>) {
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  function note(item: ReviewItem) {
    const review = item.review;
    const answering = answer?.id === item.id ? answer : null;
    return (
      <article className="review-note" key={item.id}>
        <div className="review-note-top">
          <button className="note-seek" onClick={() => onSeek(item)}>
            <span className="note-number">{number.get(item.id)}</span>
            <time>{timecode(item.time)}</time>
          </button>
        </div>
        <p>{item.body}</p>
        {review.status === "blocked" && (
          <p className="review-outcome">Agent asks: {review.question}</p>
        )}
        {review.status === "done" && (
          <p className="review-outcome">{review.note}</p>
        )}
        {item.instructions.map((instruction) => (
          <p className="review-outcome" key={instruction.at}>
            {instruction.source === "chat"
              ? "You answered in chat: "
              : "You added: "}
            {instruction.text}
          </p>
        ))}
        {review.status === "withdrawn" && (
          <p className="review-outcome">
            {
              {
                human: "You withdrew it: ",
                agent: "Agent withdrew it: ",
                external: "An outside agent withdrew it: ",
              }[review.by]
            }
            {review.reason}
          </p>
        )}
        {item.framePath && (
          <button
            className="saved-frame"
            aria-label="View annotated frame"
            onClick={() => setFrame(item)}
          >
            <img
              loading="lazy"
              src={`/api/cutroom/projects/${projectId}/attachments/${encodeURIComponent(item.framePath.split("/").at(-1) ?? "")}`}
              alt={`Annotated frame at ${timecode(item.time)}`}
            />
          </button>
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
                onClick={() => setAnswer(null)}
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
        <div className="review-note-bottom">
          <span>
            {item.kind === "drawing" ? (
              <>
                <PencilSimple size={13} />
                Drawing
              </>
            ) : (
              <>
                <ChatTeardropText size={13} />
                Comment
              </>
            )}
            {item.elementId && ` · ${item.elementId}`}
          </span>
          <div>
            {review.status === "done" && (
              <>
                <button
                  className="icon-button"
                  aria-label="Accept"
                  title="Accept"
                  onClick={() =>
                    void run(() => onAct(item, { type: "accept" }))
                  }
                >
                  <Check size={14} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Send back with changes"
                  title="Send back with changes"
                  onClick={() =>
                    setAnswer({ id: item.id, type: "reject", note: "" })
                  }
                >
                  <ArrowBendUpLeft size={14} />
                </button>
              </>
            )}
            {review.status === "blocked" && (
              <button
                className="icon-button"
                aria-label="Answer"
                title="Answer"
                onClick={() =>
                  setAnswer({ id: item.id, type: "reply", note: "" })
                }
              >
                <ChatTeardropText size={14} />
              </button>
            )}
            {review.status === "withdrawn" && (
              <button
                className="icon-button"
                aria-label="Restore to queue"
                title="Restore to queue"
                onClick={() => void run(() => onAct(item, { type: "restore" }))}
              >
                <ArrowCounterClockwise size={14} />
              </button>
            )}
            {review.status === "working" && (
              <button
                className="icon-button"
                aria-label="Return to queue"
                title="Return to queue"
                onClick={() => void run(() => onAct(item, { type: "release" }))}
              >
                <Queue size={14} />
              </button>
            )}
            {review.status !== "open" && review.status !== "withdrawn" && (
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
                <X size={14} />
              </button>
            )}
            {review.status === "open" && (
              <button
                className="icon-button"
                aria-label="Delete note"
                title="Delete"
                onClick={() => void run(() => onDelete(item))}
              >
                <Trash size={14} />
              </button>
            )}
          </div>
        </div>
      </article>
    );
  }

  return (
    <section className="review-panel" aria-label="Review notes">
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
              Note at {timecode(draft.time)}
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
                  fill="none"
                  stroke="#f2a17b"
                  strokeWidth=".005"
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
      {groups.map(([status, title]) => {
        const members = items.filter((item) => item.review.status === status);
        if (!members.length) return null;
        return (
          <section
            className="review-group"
            key={status}
            aria-label={`${title} notes`}
          >
            <h3>
              {title}
              <span>{members.length}</span>
            </h3>
            {members.map(note)}
            {status === "open" && (
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
      {accepted.length > 0 && (
        <details className="resolved-notes">
          <summary>Accepted notes</summary>
          {accepted.map((item) => (
            <div key={item.id}>
              <button onClick={() => onSeek(item)}>
                {timecode(item.time)}
              </button>
              <span>{item.body}</span>
            </div>
          ))}
        </details>
      )}
      {frame?.framePath && (
        <Modal
          title={`Review at ${timecode(frame.time)}`}
          onClose={() => setFrame(null)}
          wide
        >
          <img
            className="review-full-frame"
            src={`/api/cutroom/projects/${projectId}/attachments/${encodeURIComponent(frame.framePath.split("/").at(-1) ?? "")}`}
            alt={frame.body}
          />
          <p className="review-full-note">{frame.body}</p>
        </Modal>
      )}
    </section>
  );
}
