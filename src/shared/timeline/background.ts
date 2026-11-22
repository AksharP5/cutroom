import { z } from "zod";

/**
 * Marks a clip whose background is removed, with the edge refine. The matte itself is found by
 * the clip's source and range in the project's `mattes` folder, so stock HyperFrames ignores the
 * attribute and shows the original picture.
 */
export const BACKGROUND_ATTRIBUTE = "data-cutroom-matte";
export const MAX_EDGE = 8;
export const DEFAULT_BACKGROUND = { shrink: 1, soften: 1 } as const;

const edge = z.number().int().min(0).max(MAX_EDGE);
export const BackgroundSchema = z.object({
  shrink: edge.describe("Source pixels the matte's edge is pulled in, 0 to 8"),
  soften: edge.describe("Source pixels the matte's edge is feathered, 0 to 8"),
});
export type Background = z.infer<typeof BackgroundSchema>;

export const BackgroundEditSchema = z
  .object({
    mode: z
      .enum(["keep", "remove"])
      .optional()
      .describe("remove shows only the subject; keep restores the clip"),
    shrink: edge.optional(),
    soften: edge.optional(),
  })
  .strict();
export type BackgroundEdit = z.infer<typeof BackgroundEditSchema>;

/** Video clips only: images and other clips have no Background row. */
export const canRemoveBackground = (clip: {
  kind: string;
  adjustment: boolean;
}) => clip.kind === "video" && !clip.adjustment;

/** `shrink:1;soften:1` as written on the element; null for anything else. */
export function readBackground(value: string | undefined): Background | null {
  if (value === undefined) return null;
  const fields = Object.fromEntries(
    value
      .split(";")
      .map((part) => part.split(":").map((side) => side.trim()))
      .filter((pair) => pair.length === 2 && pair[0])
      .map(([name, number]) => [name, Number(number)]),
  );
  const parsed = BackgroundSchema.safeParse({
    ...DEFAULT_BACKGROUND,
    ...fields,
  });
  return parsed.success ? parsed.data : { ...DEFAULT_BACKGROUND };
}

export const writeBackground = (background: Background | null) =>
  background ? `shrink:${background.shrink};soften:${background.soften}` : null;

/** The clip's background after an edit; a mode left out keeps Remove when refine is set. */
export function editBackground(
  current: Background | null,
  edit: BackgroundEdit | null,
): Background | null {
  if (edit === null || edit.mode === "keep") return null;
  const base = current ?? DEFAULT_BACKGROUND;
  return {
    shrink: edit.shrink ?? base.shrink,
    soften: edit.soften ?? base.soften,
  };
}
