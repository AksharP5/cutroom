import { LinkSimple, LinkSimpleBreak } from "@phosphor-icons/react";
import { useState } from "react";
import type { Clip, CommandInput, Fps } from "../../../shared/timeline/schema";
import { editTransform } from "../../../shared/timeline/transform";
import { editTimeline } from "../timeline";
import {
  cancelTransformPreview,
  commitTransformPreview,
  previewTransform,
} from "../preview";
import { ValueField } from "./ValueField";
import type { FieldUnit } from "./fields";

type Edit = Pick<
  Extract<CommandInput, { type: "setClip" }>,
  "scale" | "scaleX" | "scaleY" | "rotation" | "crop"
>;

/** Scale, Rotation and Crop. Drags and held keys draw on the picture; release saves one step. */
export function TransformFields({
  projectId,
  clip,
  fps,
  disabled,
}: {
  projectId: string;
  clip: Clip;
  fps: Fps;
  disabled: boolean | undefined;
}) {
  const [linked, setLinked] = useState(clip.scaleX === clip.scaleY);
  const field = (
    label: string,
    value: number,
    unit: FieldUnit,
    edit: (value: number) => Edit,
    limits: { min: number; max: number; tip: string },
    before?: React.ReactNode,
  ) => (
    <ValueField
      key={`${clip.id}:${label}`}
      label={label}
      value={value}
      unit={unit}
      fps={fps}
      disabled={disabled}
      {...limits}
      before={before}
      onPreview={(next) =>
        previewTransform(clip.id, editTransform(clip, edit(next)), clip)
      }
      onCancel={() => cancelTransformPreview(clip.id, clip)}
      onCommit={async (next) => {
        if (next === null) return;
        // A typed value draws at once, as a drag does, while the saved document loads.
        previewTransform(clip.id, editTransform(clip, edit(next)), clip);
        await commitTransformPreview(clip, () =>
          editTimeline(projectId, `Edit ${label.toLowerCase()}`, () => [
            { type: "setClip", clipId: clip.id, ...edit(next) },
          ]),
        );
      }}
    />
  );
  const scale = {
    min: 0.01,
    max: 100,
    tip: "Scale from the clip's centre. Drag the label or use Up/Down. Shift for finer steps.",
  };
  const crop = {
    min: 0,
    max: 20000,
    tip: "Pixels cut from this edge of the clip. Drag the label or use Up/Down. Shift for 10 pixels.",
  };
  return (
    <>
      {field(
        "Scale X",
        clip.scaleX ?? 1,
        "percent",
        (value) => (linked ? { scale: value } : { scaleX: value }),
        scale,
      )}
      {field(
        "Scale Y",
        clip.scaleY ?? 1,
        "percent",
        (value) => (linked ? { scale: value } : { scaleY: value }),
        scale,
        <button
          type="button"
          aria-label="Link scale axes"
          aria-pressed={linked}
          title={linked ? "Scale both axes together" : "Scale each axis alone"}
          disabled={disabled}
          onClick={() => setLinked(!linked)}
        >
          {linked ? (
            <LinkSimple size={14} aria-hidden />
          ) : (
            <LinkSimpleBreak size={14} aria-hidden />
          )}
        </button>,
      )}
      {field(
        "Rotation",
        clip.rotation ?? 0,
        "degrees",
        (value) => ({ rotation: value }),
        {
          min: -3600,
          max: 3600,
          tip: "Degrees clockwise about the clip's centre. Drag the label or use Up/Down. Shift for 10 degrees.",
        },
      )}
      {(["left", "right", "top", "bottom"] as const).map((edge) =>
        field(
          `Crop ${edge[0]!.toUpperCase()}${edge.slice(1)}`,
          clip.crop?.[edge] ?? 0,
          "pixels",
          (value) => ({ crop: { [edge]: value } }),
          crop,
        ),
      )}
    </>
  );
}
