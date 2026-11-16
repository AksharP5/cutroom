import { z } from "zod";
import { fontFamily } from "./timeline/elementStyle.ts";

/** The static weights Cutroom downloads from Google Fonts, one file each. */
export const GOOGLE_FONT_WEIGHTS = [
  100, 200, 300, 400, 500, 600, 700, 800, 900,
] as const;
export type GoogleFontWeight = (typeof GOOGLE_FONT_WEIGHTS)[number];

const weight = z
  .number()
  .refine(
    (value): value is GoogleFontWeight =>
      GOOGLE_FONT_WEIGHTS.some((known) => known === value),
    "A weight is 100 to 900 in hundreds.",
  );

export const GoogleFontAddSchema = z.object({
  family: fontFamily.describe(
    "A family exactly as fonts_list returns it, such as Playfair Display",
  ),
  weights: z
    .array(weight)
    .min(1)
    .max(GOOGLE_FONT_WEIGHTS.length)
    .transform((weights) => [...new Set(weights)].sort((a, b) => a - b))
    .describe("Weights to download, each one the family offers"),
});

export const GoogleFamilySchema = z.object({
  family: fontFamily,
  category: z.string(),
  weights: z.array(weight),
});
export type GoogleFamily = z.infer<typeof GoogleFamilySchema>;

export const GoogleFamiliesSchema = z.object({
  families: z.array(GoogleFamilySchema),
});

export const FontsAddedSchema = z.object({
  families: z.array(fontFamily),
  files: z.array(z.string()),
});
export type FontsAdded = z.infer<typeof FontsAddedSchema>;

/** The font files a person can import; anything else is refused before upload. */
export const FONT_FILE_EXTENSIONS = [
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
] as const;

/** Where added fonts live, beside the ones every new project carries. */
export const PROJECT_FONT_DIR = "assets/fonts";

/** A file larger than this is refused, from Google or from disk. */
export const FONT_FILE_BYTES = 20 * 1024 * 1024;
