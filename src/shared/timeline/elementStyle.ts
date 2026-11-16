import { z } from "zod";
import type { ClipKind } from "./schema.ts";

/**
 * The look of any visual clip, written as inline CSS on the clip's own element. Every value is a
 * number, a closed set or a strict pattern, so none can carry markup, a url() or an expression.
 */

/** A family the project declares with @font-face; no quote, backslash or markup can pass. */
export const fontFamily = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,98}[A-Za-z0-9])?$/,
    "A font family uses letters, digits, spaces, hyphens and underscores.",
  );
const colour = z
  .string()
  .regex(
    /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/,
    "Use a colour as #rrggbb, or #rrggbbaa with alpha.",
  )
  .overwrite((value) => value.toLowerCase());
/** Canonical at the given decimals, so a value reads back exactly as it was written. */
const number = (min: number, max: number, decimals: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .overwrite((value) => Number(value.toFixed(decimals)) + 0);
const pixels = (min: number, max: number) => number(min, max, 2);

export const STYLE_WEIGHTS = [
  100, 200, 300, 400, 500, 600, 700, 800, 900,
] as const;
export const STYLE_ALIGNMENTS = ["left", "center", "right", "justify"] as const;
export const STYLE_CASES = [
  "none",
  "uppercase",
  "lowercase",
  "capitalize",
] as const;
export const STYLE_FITS = [
  "contain",
  "cover",
  "fill",
  "none",
  "scale-down",
] as const;

const gradient = z.object({
  from: colour,
  to: colour,
  angle: number(0, 360, 2).describe(
    "Degrees: 0 runs bottom to top, 90 left to right, 180 top to bottom",
  ),
});
const shadow = z.object({
  x: pixels(-2000, 2000),
  y: pixels(-2000, 2000),
  blur: pixels(0, 500),
  color: colour,
});

const fields = {
  fontFamily: fontFamily.describe(
    "A font family the project declares with @font-face (timeline.fonts)",
  ),
  fontSize: pixels(1, 2000).describe("Font size in composition pixels"),
  fontWeight: z.union(STYLE_WEIGHTS.map((weight) => z.literal(weight))),
  letterSpacing: number(-1, 2, 3).describe(
    "Tracking in em: 0.05 adds 5% of the font size between letters",
  ),
  lineHeight: number(0.5, 5, 3).describe(
    "Leading as a multiple of the font size",
  ),
  color: colour.describe("Text colour"),
  textAlign: z.enum(STYLE_ALIGNMENTS),
  textTransform: z
    .enum(STYLE_CASES)
    .describe("Letter case; none shows the words as written"),
  fill: z
    .union([colour, gradient])
    .describe(
      "Background: a colour, or a linear gradient {from, to, angle}. Replaces any inline background",
    ),
  borderRadius: pixels(0, 10_000).describe("Corner radius in pixels"),
  shadow: shadow.describe(
    "Drop shadow following what the clip draws (letters, a rounded box, an image's alpha): offset, blur in pixels, colour with optional alpha",
  ),
  blur: pixels(0, 500).describe("Gaussian blur radius in pixels"),
  width: pixels(0, 100_000).describe("Layout width in composition pixels"),
  height: pixels(0, 100_000).describe("Layout height in composition pixels"),
  objectFit: z
    .enum(STYLE_FITS)
    .describe("How a video or image fills its box; video and image clips only"),
};

export const ElementStyleSchema = z.object(fields).partial();

/** A style change: fields left out keep their values, and null removes one. */
export const ElementStyleEditSchema = z
  .object({
    fontFamily: fields.fontFamily.nullable(),
    fontSize: fields.fontSize.nullable(),
    fontWeight: fields.fontWeight.nullable(),
    letterSpacing: fields.letterSpacing.nullable(),
    lineHeight: fields.lineHeight.nullable(),
    color: fields.color.nullable(),
    textAlign: fields.textAlign.nullable(),
    textTransform: fields.textTransform.nullable(),
    fill: fields.fill.nullable(),
    borderRadius: fields.borderRadius.nullable(),
    shadow: fields.shadow.nullable(),
    blur: fields.blur.nullable(),
    width: fields.width.nullable(),
    height: fields.height.nullable(),
    objectFit: fields.objectFit.nullable(),
  })
  .partial();

export type ElementStyle = z.infer<typeof ElementStyleSchema>;
export type ElementStyleEdit = z.infer<typeof ElementStyleEditSchema>;
export type StyleField = keyof ElementStyle;

/** Fields that style words, which only element clips hold. */
export const TEXT_STYLE_FIELDS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "color",
  "textAlign",
  "textTransform",
] as const satisfies readonly StyleField[];

/** Whether a clip of this kind takes a style field: words need a text element, a fit a picture. */
export const takesStyleField = (kind: ClipKind, field: string) =>
  TEXT_STYLE_FIELDS.some((text) => text === field)
    ? kind === "element"
    : field === "objectFit"
      ? kind === "video" || kind === "image"
      : kind !== "audio" && kind !== "voiceover";

/** The style with the edit applied; null removes a field. */
export function editStyle(
  style: ElementStyle,
  edit: ElementStyleEdit,
): ElementStyle {
  const next: Record<string, unknown> = { ...style };
  for (const [field, value] of Object.entries(edit))
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  return ElementStyleSchema.parse(next);
}

/**
 * The inline CSS declarations a style writes; null leaves a property unset. Shadow and blur share
 * `filter`, so the browser draws the shadow first and blurs it with the clip.
 */
export function styleDeclarations(style: ElementStyle) {
  const px = (value: number | undefined) =>
    value === undefined ? null : `${value}px`;
  const { fill, shadow } = style;
  const filter = [
    shadow &&
      `drop-shadow(${shadow.x}px ${shadow.y}px ${shadow.blur}px ${shadow.color})`,
    style.blur !== undefined && `blur(${style.blur}px)`,
  ].filter(Boolean);
  return {
    "font-family":
      style.fontFamily === undefined
        ? null
        : `"${style.fontFamily}", sans-serif`,
    "font-size": px(style.fontSize),
    "font-weight":
      style.fontWeight === undefined ? null : String(style.fontWeight),
    "letter-spacing":
      style.letterSpacing === undefined ? null : `${style.letterSpacing}em`,
    "line-height":
      style.lineHeight === undefined ? null : String(style.lineHeight),
    color: style.color ?? null,
    "text-align": style.textAlign ?? null,
    "text-transform": style.textTransform ?? null,
    background:
      fill === undefined
        ? null
        : typeof fill === "string"
          ? fill
          : `linear-gradient(${fill.angle}deg, ${fill.from}, ${fill.to})`,
    "border-radius": px(style.borderRadius),
    filter: filter.length ? filter.join(" ") : null,
    width: px(style.width),
    height: px(style.height),
    "object-fit": style.objectFit ?? null,
  };
}
export type StyleProperty = keyof ReturnType<typeof styleDeclarations>;

/** Whether two styles draw the same, whichever objects and key order carry them. */
export const sameStyle = (a: ElementStyle, b: ElementStyle) =>
  JSON.stringify(styleDeclarations(a)) === JSON.stringify(styleDeclarations(b));
