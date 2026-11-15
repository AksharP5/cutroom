import { LinkSimple, LinkSimpleBreak } from "@phosphor-icons/react";
import { useState } from "react";
import type { Clip, CommandInput, Fps } from "../../../shared/timeline/schema";
import { editTransform } from "../../../shared/timeline/transform";
import { editTimeline } from "../timeline";
import {
  cancelTransformPreview,
  commitTransformPreview,
  previewTransform,
  usePictureScale,
} from "../preview";
import { FieldRow, ValueCell, ValueField } from "./ValueField";
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
  // A scale on the picture's handles shows here while it lasts.
  const gesture = usePictureScale((state) => state.scale);
  const shown = gesture?.clipId === clip.id ? gesture : clip;
  const reset = (label: string, edit: Edit) => () =>
    void editTimeline(projectId, label, () => [
      { type: "setClip", clipId: clip.id, ...edit },
    ]);
  const props = (
    label: string,
    value: number,
    initial: number,
    unit: FieldUnit,
    edit: (value: number) => Edit,
    limits: { min: number; max: number; tip: string },
  ) => ({
    label,
    value,
    initial,
    unit,
    fps,
    disabled,
    ...limits,
    onPreview: (next: number) =>
      previewTransform(clip.id, editTransform(clip, edit(next)), clip),
    onCancel: () => cancelTransformPreview(clip.id, clip),
    onCommit: async (next: number | null) => {
      if (next === null) return;
      // A typed value draws at once, as a drag does, while the saved document loads.
      previewTransform(clip.id, editTransform(clip, edit(next)), clip);
      await commitTransformPreview(clip, () =>
        editTimeline(projectId, `Edit ${label.toLowerCase()}`, () => [
          { type: "setClip", clipId: clip.id, ...edit(next) },
        ]),
      );
    },
  });
  const scale = {
    min: 0.01,
    max: 100,
    tip: "Scale from the clip's centre. Drag the letter or use Up/Down. Shift for finer steps.",
  };
  const crop = {
    min: 0,
    max: 20000,
    tip: "Pixels cut from this edge of the clip. Drag the letter or use Up/Down. Shift for 10 pixels.",
  };
  return (
    <>
      <FieldRow
        label="Scale"
        disabled={disabled}
        onReset={reset("Reset scale", { scale: null })}
        extra={
          <button
            type="button"
            aria-label="Link scale axes"
            aria-pressed={linked}
            title={
              linked ? "Scale both axes together" : "Scale each axis alone"
            }
            disabled={disabled}
            onClick={() => setLinked(!linked)}
          >
            {linked ? (
              <LinkSimple size={12} aria-hidden />
            ) : (
              <LinkSimpleBreak size={12} aria-hidden />
            )}
          </button>
        }
      >
        {(["X", "Y"] as const).map((axis) => (
          <ValueCell
            key={axis}
            axis={axis}
            {...props(
              `Scale ${axis}`,
              shown[`scale${axis}`] ?? 1,
              1,
              "percent",
              (value) =>
                linked ? { scale: value } : { [`scale${axis}`]: value },
              scale,
            )}
          />
        ))}
      </FieldRow>
      <ValueField
        {...props(
          "Rotation",
          clip.rotation ?? 0,
          0,
          "degrees",
          (value) => ({ rotation: value }),
          {
            min: -3600,
            max: 3600,
            tip: "Degrees clockwise about the clip's centre. Drag the label or use Up/Down. Shift for 10 degrees.",
          },
        )}
        onReset={reset("Reset rotation", { rotation: null })}
        half
      />
      <FieldRow
        label="Crop"
        disabled={disabled}
        onReset={reset("Reset crop", { crop: null })}
      >
        {(["left", "top", "right", "bottom"] as const).map((edge) => (
          <ValueCell
            key={edge}
            axis={edge[0]!.toUpperCase()}
            {...props(
              `Crop ${edge[0]!.toUpperCase()}${edge.slice(1)}`,
              clip.crop?.[edge] ?? 0,
              0,
              "pixels",
              (value) => ({ crop: { [edge]: value } }),
              crop,
            )}
            bare
          />
        ))}
      </FieldRow>
    </>
  );
}
