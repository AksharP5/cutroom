import { ClosedCaptioning } from "@phosphor-icons/react";
import { z } from "zod";
import {
  CAPTION_STYLES,
  CAPTION_STYLE_LABELS,
  CaptionsViewSchema,
  SubtitleFormatSchema,
} from "../../shared/captions";
import type {
  CaptionsEdit,
  CaptionsView,
  SubtitleFormat,
} from "../../shared/captions";
import { SelectMenu } from "./SelectMenu";
import { api, json } from "../api";

export const CaptionsListSchema = z.object({
  captions: z.array(CaptionsViewSchema),
});
const ExportSchema = z.object({
  format: SubtitleFormatSchema,
  filename: z.string(),
  text: z.string(),
});

/** Sends one captions edit; the server answers with the captions as they now are. */
export const editCaptions = (projectId: string, edit: CaptionsEdit) =>
  api(
    `/projects/${projectId}/captions`,
    CaptionsViewSchema,
    json("POST", edit),
  );

async function download(
  projectId: string,
  transcriptId: string,
  format: SubtitleFormat,
) {
  const file = await api(
    `/projects/${projectId}/captions/${encodeURIComponent(transcriptId)}/export?format=${format}`,
    ExportSchema,
  );
  const url = URL.createObjectURL(
    new Blob([file.text], {
      type: format === "vtt" ? "text/vtt" : "application/x-subrip",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Add, restyle, update and export one transcript's captions. */
export function CaptionControls({
  projectId,
  transcriptId,
  captions,
  busy,
  run,
}: {
  projectId: string;
  transcriptId: string;
  captions: CaptionsView | undefined;
  busy: boolean;
  /** Runs an action with the panel's busy state and error line. */
  run: (action: () => Promise<unknown>, changesProject?: boolean) => void;
}) {
  if (!captions)
    return (
      <div className="script-captions">
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            run(() =>
              editCaptions(projectId, { action: "generate", transcriptId }),
            )
          }
        >
          <ClosedCaptioning size={14} />
          Add captions
        </button>
      </div>
    );
  return (
    <div className="script-captions" aria-label="Captions">
      <span className="field-label">Captions</span>
      <SelectMenu
        label="Caption style"
        value={captions.style}
        disabled={busy}
        options={CAPTION_STYLES.map((style) => ({
          value: style,
          label: CAPTION_STYLE_LABELS[style],
        }))}
        onChange={(style) =>
          run(() =>
            editCaptions(projectId, { action: "style", transcriptId, style }),
          )
        }
      />
      {(["srt", "vtt"] as const).map((format) => (
        <button
          key={format}
          className="text-button"
          aria-label={`Export ${format.toUpperCase()}`}
          title={`Export ${format.toUpperCase()}`}
          disabled={busy}
          onClick={() =>
            run(() => download(projectId, transcriptId, format), false)
          }
        >
          {format.toUpperCase()}
        </button>
      ))}
      {captions.stale && (
        <p className="script-captions-stale">
          The footage changed since these captions were made.
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              run(() =>
                editCaptions(projectId, { action: "generate", transcriptId }),
              )
            }
          >
            Update captions
          </button>
        </p>
      )}
    </div>
  );
}
