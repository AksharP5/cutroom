import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChatTeardropText,
  PencilSimple,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { Annotation } from "../../shared/project";
import type { EditorReviewDraft } from "../../shared/editor";
import { timecode } from "../api";
import { Modal } from "./Modal";

export function ReviewPanel({
  projectId,
  annotations,
  draft,
  onSave,
  onCancel,
  onSeek,
  onResolve,
  onDelete,
  onSend,
}: {
  projectId: string;
  annotations: Annotation[];
  draft: EditorReviewDraft | null;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
  onSeek: (annotation: Annotation) => void;
  onResolve: (annotation: Annotation) => Promise<void>;
  onDelete: (annotation: Annotation) => Promise<void>;
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
  const [frame, setFrame] = useState<Annotation | null>(null);
  useEffect(() => setBody(""), [draft]);
  const open = annotations.filter(
    (annotation) => annotation.status !== "resolved",
  );
  const pending = open.filter((annotation) => annotation.status === "open");

  async function run(action: () => Promise<void>) {
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
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
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {open.length === 0 && !draft && (
        <div className="small-empty">
          <ChatTeardropText size={25} weight="light" />
          <h3>Start with what you see.</h3>
          <p>
            Draw on the picture or pin a comment. Your notes collect here before
            you send them.
          </p>
        </div>
      )}
      {open.map((annotation, index) => (
        <article className="review-note" key={annotation.id}>
          <div className="review-note-top">
            <button className="note-seek" onClick={() => onSeek(annotation)}>
              <span className="note-number">{index + 1}</span>
              <time>{timecode(annotation.time)}</time>
            </button>
            <span className="note-state">
              {annotation.status === "sent" ? "Sent" : "Pending"}
            </span>
          </div>
          <p>{annotation.body}</p>
          {annotation.framePath && (
            <button
              className="saved-frame"
              aria-label="View annotated frame"
              onClick={() => setFrame(annotation)}
            >
              <img
                loading="lazy"
                src={`/api/cutroom/projects/${projectId}/attachments/${encodeURIComponent(annotation.framePath.split("/").at(-1) ?? "")}`}
                alt={`Annotated frame at ${timecode(annotation.time)}`}
              />
            </button>
          )}
          <div className="review-note-bottom">
            <span>
              {annotation.kind === "drawing" ? (
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
              {annotation.elementId && ` · ${annotation.elementId}`}
            </span>
            <div>
              <button
                className="icon-button"
                aria-label="Resolve note"
                onClick={() => void run(() => onResolve(annotation))}
              >
                <Check size={14} />
              </button>
              <button
                className="icon-button"
                aria-label="Delete note"
                onClick={() => void run(() => onDelete(annotation))}
              >
                <Trash size={14} />
              </button>
            </div>
          </div>
        </article>
      ))}
      {pending.length > 0 && (
        <div className="review-send">
          <button className="secondary-button" onClick={onSend}>
            Use {pending.length} {pending.length === 1 ? "note" : "notes"} in
            chat
            <ArrowUpRight size={15} />
          </button>
        </div>
      )}
      {annotations.some((annotation) => annotation.status === "resolved") && (
        <details className="resolved-notes">
          <summary>Resolved notes</summary>
          {annotations
            .filter((annotation) => annotation.status === "resolved")
            .map((annotation) => (
              <div key={annotation.id}>
                <button onClick={() => onSeek(annotation)}>
                  {timecode(annotation.time)}
                </button>
                <span>{annotation.body}</span>
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
