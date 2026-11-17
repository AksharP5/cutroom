import { useMemo, useState } from "react";
import { ClosedCaptioning } from "@phosphor-icons/react";
import { z } from "zod";
import {
  CAPTION_STYLES,
  CAPTION_WORD_TRANSFORM_DEFAULTS,
  CaptionWordTransformSchema,
  CAPTION_STYLE_LABELS,
  CaptionsViewSchema,
  SubtitleFormatSchema,
} from "../../shared/captions";
import type {
  CaptionWordTransform,
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

const wordFields = [
  {
    key: "x",
    label: "X",
    description: "Caption X position",
    unit: "px",
    factor: 1,
  },
  {
    key: "y",
    label: "Y",
    description: "Caption Y position",
    unit: "px",
    factor: 1,
  },
  {
    key: "scale",
    label: "Scale",
    description: "Caption scale",
    unit: "%",
    factor: 100,
  },
  {
    key: "rotation",
    label: "Angle",
    description: "Caption rotation",
    unit: "°",
    factor: 1,
  },
] as const;

export function CaptionTransformFields({
  captions,
  wordIds,
  busy,
  onApply,
  onCancel,
}: {
  captions: CaptionsView;
  wordIds: readonly string[];
  busy: boolean;
  onApply: (transform: CaptionWordTransform | null) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<
    Partial<Record<keyof CaptionWordTransform, string>>
  >({});
  const fields = useMemo(
    () =>
      wordFields.map((field) => {
        const valueOf = (id: string) =>
          captions.wordTransforms[id]?.[field.key] ??
          CAPTION_WORD_TRANSFORM_DEFAULTS[field.key];
        const first = wordIds[0] ? valueOf(wordIds[0]) : 0;
        const mixed = wordIds.some((id) => valueOf(id) !== first);
        return {
          ...field,
          initial: mixed
            ? ""
            : String(Number((first * field.factor).toFixed(6))),
          mixed,
        };
      }),
    [captions.wordTransforms, wordIds],
  );
  const canReset = wordIds.some((id) =>
    Object.hasOwn(captions.wordTransforms, id),
  );
  const entries = fields.flatMap(({ key, factor }) => {
    const value = draft[key];
    return value ? [[key, Number(value) / factor] as const] : [];
  });
  const transform = CaptionWordTransformSchema.safeParse(
    Object.fromEntries(entries),
  );
  return (
    <form
      className="script-caption-transform"
      aria-label="Caption word transform"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && transform.success && entries.length)
          onApply(transform.data);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onCancel();
      }}
    >
      {fields.map(({ key, label, description, unit, initial, mixed }) => (
        <label key={key}>
          <span>{label}</span>
          <input
            type="number"
            autoFocus={key === "x"}
            step="any"
            aria-label={description}
            aria-invalid={
              !transform.success &&
              transform.error.issues.some((issue) => issue.path[0] === key)
                ? true
                : undefined
            }
            placeholder={mixed ? "Mixed" : undefined}
            value={draft[key] ?? initial}
            onChange={(event) =>
              setDraft({ ...draft, [key]: event.currentTarget.value })
            }
            disabled={busy}
          />
          <span>{unit}</span>
        </label>
      ))}
      {!transform.success && (
        <p className="script-caption-transform-error" role="alert">
          {transform.error.issues[0]?.message}
        </p>
      )}
      <div className="script-caption-transform-actions">
        <button
          className="text-button"
          type="button"
          disabled={!canReset || busy}
          onClick={() => onApply(null)}
        >
          Reset
        </button>
        <button
          className="text-button"
          type="submit"
          disabled={busy || !transform.success || !entries.length}
        >
          Apply
        </button>
      </div>
    </form>
  );
}
