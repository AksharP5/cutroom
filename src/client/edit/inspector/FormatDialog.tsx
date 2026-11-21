import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import {
  FormatPreviewSchema,
  ProjectFormatSchema,
  sameRate,
} from "../../../shared/projectFormat";
import type { ProjectFormat } from "../../../shared/projectFormat";
import type { TimelineView } from "../../../shared/timeline/schema";
import { FormatFields } from "../../components/FormatFields";
import { Modal } from "../../components/Modal";
import { changeFormat, previewFormat } from "../projectFormat";
import { useTimeline } from "../timeline";

type Preview = z.infer<typeof FormatPreviewSchema>;

export function FormatDialog({
  projectId,
  view,
  size,
  onClose,
}: {
  projectId: string;
  view: TimelineView;
  size: Pick<ProjectFormat, "width" | "height">;
  onClose(): void;
}) {
  const [format, setFormat] = useState({ ...size, fps: view.timeline.fps });
  const [checked, setChecked] = useState<{
    format: ProjectFormat;
    result: Preview | string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const current = useTimeline((state) => state.view?.revision);
  const stale = current !== view.revision;
  const valid = ProjectFormatSchema.safeParse(format).success;
  const rateChanged = !sameRate(view.timeline.fps, format.fps);
  const changed =
    rateChanged || format.width !== size.width || format.height !== size.height;
  useEffect(() => {
    if (!valid || !changed || stale) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void previewFormat(projectId, view, format, abort.signal).then(
        (result) => {
          if (!abort.signal.aborted) setChecked({ format, result });
        },
        (error: unknown) => {
          if (!abort.signal.aborted)
            setChecked({
              format,
              result: error instanceof Error ? error.message : String(error),
            });
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [format, projectId, view, valid, changed, stale]);

  const result = checked?.format === format ? checked.result : null;
  const preview = typeof result === "object" ? result : null;
  const error =
    failure ||
    (stale && !saving
      ? "The timeline changed. Reopen Format to review the latest version."
      : typeof result === "string"
        ? result
        : "");
  const summary =
    preview && rateChanged
      ? preview.movedEdges
        ? `${preview.movedEdges} clip ${preview.movedEdges === 1 ? "edge moves" : "edges move"} to the new grid (up to ${Number(preview.maxShiftMs.toPrecision(3))} ms).`
        : view.timeline.clips.length
          ? "All clip edges already line up with the new grid."
          : ""
      : "";
  const canSave = preview !== null && !stale && !saving;

  return createPortal(
    <Modal title="Project format" onClose={saving ? () => {} : onClose}>
      <form
        className="project-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          setSaving(true);
          setFailure("");
          void changeFormat(projectId, view, format).then(
            onClose,
            (error: unknown) => {
              setFailure(
                error instanceof Error ? error.message : String(error),
              );
              setSaving(false);
            },
          );
        }}
      >
        <FormatFields
          format={format}
          disabled={saving}
          onChange={(next) => {
            setFailure("");
            setFormat(next);
          }}
        />
        <p
          className="format-preview"
          role="status"
          data-error={error ? "" : undefined}
        >
          {error ||
            (!valid
              ? "Enter a width and height from 240 to 7680 pixels."
              : summary || (changed && !preview ? "Checking timeline…" : ""))}
        </p>
        <footer className="modal-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="primary-button" disabled={!canSave}>
            {saving ? "Applying…" : "Apply format"}
          </button>
        </footer>
      </form>
    </Modal>,
    document.body,
  );
}
