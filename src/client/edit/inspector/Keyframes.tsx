import type { Clip, KeyframeProperty } from "../../../shared/timeline/schema";
import { keyframeCss, tracksOf } from "../../../shared/timeline/keyframes";
import type { KeyframeValues } from "../../../shared/timeline/keyframes";
import { editTimeline } from "../timeline";
import { commitKeyframePreview, previewKeyframe } from "../preview";
import { useTransport } from "../transport";

const NAMES = {
  position: "Position",
  scale: "Scale",
  rotation: "Rotation",
  crop: "Crop",
  opacity: "Opacity",
} satisfies Record<KeyframeProperty, string>;

/**
 * The clip-local frame a keyframed clip's fields show: the playhead's, held inside the clip. Only a
 * clip with keyframes follows the playhead, so a static clip's fields never re-render with it.
 */
export function useClipFrame(clip: Clip) {
  const keyed = clip.keyframes !== null;
  const frame = useTransport((state) => (keyed ? state.frame : clip.start));
  return Math.max(0, Math.min(clip.duration - 1, frame - clip.start));
}

/** An in-between value as a field shows it: hundredths, or hundredths of a percent. */
export const rounded = (value: number, percent = false) =>
  Number(value.toFixed(percent ? 4 : 2));

export const isKeyed = (clip: Clip, property: KeyframeProperty) =>
  tracksOf(clip)[property] !== undefined;

/** Draws a keyframed property's value on the picture before it saves. */
export const draftKeyframe = <P extends KeyframeProperty>(
  clip: Clip,
  property: P,
  value: KeyframeValues[P],
) => {
  const [name, css] = keyframeCss(property, value);
  previewKeyframe(clip.id, { [name]: css });
};

export const cancelKeyframeDraft = (clip: Clip) =>
  previewKeyframe(clip.id, null);

/** Saves a keyframed property's value as the keyframe at the playhead, adding one if none is there. */
export const commitKeyframe = <P extends KeyframeProperty>(
  projectId: string,
  clip: Clip,
  property: P,
  local: number,
  value: KeyframeValues[P],
) =>
  commitKeyframePreview(() =>
    editTimeline(
      projectId,
      `Edit ${NAMES[property].toLowerCase()} keyframe`,
      () => [
        { type: "setKeyframe", clipId: clip.id, property, frame: local, value },
      ],
    ),
  );

/**
 * A row's keyframe diamond: hollow while the property is static, outlined once it has keyframes,
 * filled on a keyframe. A press adds a keyframe at the playhead with the value shown, or removes
 * the one there.
 */
export function KeyframeButton({
  projectId,
  clip,
  property,
  disabled,
}: {
  projectId: string;
  clip: Clip;
  property: KeyframeProperty;
  disabled: boolean | undefined;
}) {
  const track = tracksOf(clip)[property];
  // Renders only when the playhead crosses a keyframe or the clip's edges, never per frame.
  const state = useTransport(({ frame }) => {
    const local = frame - clip.start;
    if (local < 0 || local >= clip.duration) return "outside";
    if (!track) return "off";
    return track.some((keyframe) => keyframe.frame === local) ? "on" : "keyed";
  });
  const inside = state !== "outside";
  const on = state === "on";
  const name = NAMES[property];
  return (
    <button
      type="button"
      className="inspector-keyframe"
      data-state={on ? "on" : track ? "keyed" : "off"}
      aria-label={`${name} keyframe`}
      aria-pressed={on}
      title={
        !inside
          ? "Move the playhead over the clip to set a keyframe"
          : on
            ? `Remove the ${name.toLowerCase()} keyframe here`
            : `Add a ${name.toLowerCase()} keyframe here`
      }
      disabled={disabled || !inside}
      onClick={(event) => {
        // A press inside a row label would otherwise start that label's scrub.
        event.stopPropagation();
        const local = useTransport.getState().frame - clip.start;
        void editTimeline(
          projectId,
          on
            ? `Remove ${name.toLowerCase()} keyframe`
            : `Add ${name.toLowerCase()} keyframe`,
          () => [
            on
              ? {
                  type: "removeKeyframe",
                  clipId: clip.id,
                  property,
                  frame: local,
                }
              : {
                  type: "setKeyframe",
                  clipId: clip.id,
                  property,
                  frame: local,
                },
          ],
        );
      }}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}
