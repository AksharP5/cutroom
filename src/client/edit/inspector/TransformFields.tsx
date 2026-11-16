import { LinkSimple, LinkSimpleBreak } from "@phosphor-icons/react";
import { useState } from "react";
import type {
  Clip,
  CommandInput,
  Fps,
  KeyframeProperty,
} from "../../../shared/timeline/schema";
import { editTransform } from "../../../shared/timeline/transform";
import { valueAt } from "../../../shared/timeline/keyframes";
import type { KeyframeValues } from "../../../shared/timeline/keyframes";
import { editTimeline } from "../timeline";
import {
  cancelTransformPreview,
  commitTransformPreview,
  previewTransform,
  usePictureScale,
} from "../preview";
import { FieldRow, ValueCell, ValueField } from "./ValueField";
import type { FieldUnit } from "./fields";
import {
  KeyframeButton,
  cancelKeyframeDraft,
  commitKeyframe,
  draftKeyframe,
  isKeyed,
  rounded,
  useClipFrame,
} from "./Keyframes";

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
  const local = useClipFrame(clip);
  const scaleNow = valueAt(clip, "scale", local);
  const [linked, setLinked] = useState(scaleNow.x === scaleNow.y);
  // A scale on the picture's handles shows here while it lasts.
  const gesture = usePictureScale((state) => state.scale);
  const shown =
    gesture?.clipId === clip.id
      ? { x: gesture.scaleX, y: gesture.scaleY }
      : { x: rounded(scaleNow.x, true), y: rounded(scaleNow.y, true) };
  const reset =
    <P extends KeyframeProperty>(
      label: string,
      edit: Edit,
      property: P,
      identity: KeyframeValues[P],
    ) =>
    () =>
      isKeyed(clip, property)
        ? void commitKeyframe(projectId, clip, property, local, identity)
        : void editTimeline(projectId, label, () => [
            { type: "setClip", clipId: clip.id, ...edit },
          ]);
  /**
   * A field's handlers: a static value drafts and saves through `setClip`, a keyframed one as the
   * keyframe at the playhead.
   */
  const props = <P extends KeyframeProperty>(
    label: string,
    value: number,
    initial: number,
    unit: FieldUnit,
    edit: (value: number) => Edit,
    limits: { min: number; max: number; tip: string },
    property: P,
    keyframe: (value: number) => KeyframeValues[P],
  ) => {
    const keyed = isKeyed(clip, property);
    return {
      label,
      value,
      initial,
      unit,
      fps,
      disabled,
      ...limits,
      onPreview: (next: number) =>
        keyed
          ? draftKeyframe(clip, property, keyframe(next))
          : previewTransform(clip.id, editTransform(clip, edit(next)), clip),
      onCancel: () =>
        keyed
          ? cancelKeyframeDraft(clip)
          : cancelTransformPreview(clip.id, clip),
      onCommit: async (next: number | null) => {
        if (next === null) return;
        if (keyed) {
          draftKeyframe(clip, property, keyframe(next));
          await commitKeyframe(
            projectId,
            clip,
            property,
            local,
            keyframe(next),
          );
          return;
        }
        // A typed value draws at once, as a drag does, while the saved document loads.
        previewTransform(clip.id, editTransform(clip, edit(next)), clip);
        await commitTransformPreview(clip, () =>
          editTimeline(projectId, `Edit ${label.toLowerCase()}`, () => [
            { type: "setClip", clipId: clip.id, ...edit(next) },
          ]),
        );
      },
    };
  };
  const rotation = valueAt(clip, "rotation", local);
  const cropNow = valueAt(clip, "crop", local);
  const diamond = (property: KeyframeProperty) => (
    <KeyframeButton
      projectId={projectId}
      clip={clip}
      property={property}
      disabled={disabled}
    />
  );
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
        onReset={reset("Reset scale", { scale: null }, "scale", { x: 1, y: 1 })}
        keyframe={diamond("scale")}
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
              shown[axis === "X" ? "x" : "y"],
              1,
              "percent",
              (value) =>
                linked ? { scale: value } : { [`scale${axis}`]: value },
              scale,
              "scale",
              (value) =>
                linked
                  ? { x: value, y: value }
                  : { ...scaleNow, [axis === "X" ? "x" : "y"]: value },
            )}
          />
        ))}
      </FieldRow>
      <ValueField
        {...props(
          "Rotation",
          rounded(rotation),
          0,
          "degrees",
          (value) => ({ rotation: value }),
          {
            min: -3600,
            max: 3600,
            tip: "Degrees clockwise about the clip's centre. Drag the label or use Up/Down. Shift for 10 degrees.",
          },
          "rotation",
          (value) => value,
        )}
        keyframe={diamond("rotation")}
        onReset={reset("Reset rotation", { rotation: null }, "rotation", 0)}
        half
      />
      <FieldRow
        label="Crop"
        disabled={disabled}
        onReset={reset("Reset crop", { crop: null }, "crop", {
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
        })}
        keyframe={diamond("crop")}
      >
        {(["left", "top", "right", "bottom"] as const).map((edge) => (
          <ValueCell
            key={edge}
            axis={edge[0]!.toUpperCase()}
            {...props(
              `Crop ${edge[0]!.toUpperCase()}${edge.slice(1)}`,
              rounded(cropNow[edge]),
              0,
              "pixels",
              (value) => ({ crop: { [edge]: value } }),
              crop,
              "crop",
              (value) => ({ ...cropNow, [edge]: value }),
            )}
            bare
          />
        ))}
      </FieldRow>
    </>
  );
}
