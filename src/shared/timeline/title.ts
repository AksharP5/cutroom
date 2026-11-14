import type { Fps, Title, TitleEdit } from "./schema";

/** Default entrance and exit lengths in seconds, rounded to the timeline's frames. */
const DEFAULT_IN_SECONDS = 0.4;
const DEFAULT_OUT_SECONDS = 0.3;

const framesOf = (seconds: number, fps: Fps) =>
  Math.round((seconds * fps.num) / fps.den);

export const defaultTitle = (fps: Fps): Title => ({
  position: "lower-left",
  font: null,
  size: 64,
  weight: 600,
  color: "#ffffff",
  align: "left",
  plate: null,
  in: { preset: "fade", frames: framesOf(DEFAULT_IN_SECONDS, fps) },
  out: { preset: "fade", frames: framesOf(DEFAULT_OUT_SECONDS, fps) },
});

/** A title with the edit's fields replaced; a motion keeps whichever part the edit leaves out. */
export const editTitle = (title: Title, edit: TitleEdit): Title => ({
  ...title,
  ...edit,
  in: { ...title.in, ...edit.in },
  out: { ...title.out, ...edit.out },
});

/**
 * The two pieces of a title cut in two. The picture runs straight through the cut, so the left
 * piece keeps the entrance, the right piece keeps the exit, and neither animates at the cut.
 */
export const cutTitle = (title: Title): { left: Title; right: Title } => ({
  left: { ...title, out: { ...title.out, preset: "none" } },
  right: { ...title, in: { ...title.in, preset: "none" } },
});

/** Whether two titles hold the same settings, whichever objects carry them. */
export const sameTitle = (a: Title | null, b: Title | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    (Object.keys(a) as (keyof Title)[]).every((key) =>
      key === "in" || key === "out"
        ? a[key].preset === b[key].preset && a[key].frames === b[key].frames
        : a[key] === b[key],
    ));
