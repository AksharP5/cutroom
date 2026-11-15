import type { Clip, Command } from "./schema";

type SetClip = Extract<Command, { type: "setClip" }>;

export type ClipTransform = Pick<
  Clip,
  "scaleX" | "scaleY" | "rotation" | "crop"
>;
type TransformEdit = Pick<
  SetClip,
  "scale" | "scaleX" | "scaleY" | "rotation" | "crop"
>;

/** The inline CSS longhands Cutroom owns for a clip's transform; null leaves one unset. */
export const transformStyle = ({
  scaleX,
  scaleY,
  rotation,
  crop,
}: ClipTransform) => ({
  scale:
    scaleX === null || scaleY === null
      ? null
      : scaleX === scaleY
        ? String(scaleX)
        : `${scaleX} ${scaleY}`,
  rotate: rotation === null ? null : `${rotation}deg`,
  "clip-path":
    crop === null
      ? null
      : `inset(${crop.top}px ${crop.right}px ${crop.bottom}px ${crop.left}px)`,
});

/**
 * Applies a `setClip` transform change. The identity is stored as null, so a clip at 100%,
 * 0° and no crop carries no inline style, and one axis set alone leaves the other at 1.
 */
export function editTransform(
  clip: ClipTransform,
  edit: TransformEdit,
): ClipTransform {
  const scaleX =
    (edit.scaleX !== undefined
      ? edit.scaleX
      : edit.scale !== undefined
        ? edit.scale
        : clip.scaleX) ?? 1;
  const scaleY =
    (edit.scaleY !== undefined
      ? edit.scaleY
      : edit.scale !== undefined
        ? edit.scale
        : clip.scaleY) ?? 1;
  const base = clip.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const crop =
    edit.crop === undefined
      ? clip.crop
      : edit.crop && {
          top: edit.crop.top ?? base.top,
          right: edit.crop.right ?? base.right,
          bottom: edit.crop.bottom ?? base.bottom,
          left: edit.crop.left ?? base.left,
        };
  const rotation = edit.rotation !== undefined ? edit.rotation : clip.rotation;
  return {
    ...(scaleX === 1 && scaleY === 1
      ? { scaleX: null, scaleY: null }
      : { scaleX, scaleY }),
    rotation: rotation || null,
    crop: crop && Object.values(crop).some(Boolean) ? crop : null,
  };
}

export const hasTransformEdit = (edit: TransformEdit) =>
  edit.scale !== undefined ||
  edit.scaleX !== undefined ||
  edit.scaleY !== undefined ||
  edit.rotation !== undefined ||
  edit.crop !== undefined;

/**
 * A draft relative to the saved values. Once GSAP parses an element it folds the saved
 * longhands into its own transform, so a preview draws only the difference on top.
 */
export function relativeTransformStyle(
  draft: ClipTransform,
  saved: ClipTransform,
) {
  const scaleX = (draft.scaleX ?? 1) / (saved.scaleX ?? 1);
  const scaleY = (draft.scaleY ?? 1) / (saved.scaleY ?? 1);
  const unscaled = scaleX === 1 && scaleY === 1;
  return transformStyle({
    scaleX: unscaled ? null : scaleX,
    scaleY: unscaled ? null : scaleY,
    rotation: (draft.rotation ?? 0) - (saved.rotation ?? 0) || null,
    crop: draft.crop,
  });
}
export type TransformStyle = ReturnType<typeof transformStyle>;
