// The export worker loads this file in Node through schema.ts: erasable type syntax only.
import { z } from "zod";

export const REGION_EFFECTS = ["zoom", "blur", "highlight"] as const;
export const REGION_EASES = [
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "expo-in",
  "expo-out",
] as const;
export const REGION_AREAS = ["inside", "outside"] as const;
/** The closest a zoom goes: its box is at least a tenth of the frame. */
export const MAX_ZOOM = 10;

/** Cubic-bezier control points for each ease, shared by the stylesheet and the editor's curves. */
export const REGION_EASE_CURVES = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  "expo-in": [0.7, 0, 0.84, 0],
  "expo-out": [0.16, 1, 0.3, 1],
} as const;

const fraction = z.number().min(0).max(1);
const ramp = z.number().int().min(0).max(100_000);

export const RegionBoxSchema = z
  .object({
    x: fraction.describe("Left edge, as a fraction of the frame's width"),
    y: fraction.describe("Top edge, as a fraction of the frame's height"),
    width: z.number().min(0.01).max(1),
    height: z.number().min(0.01).max(1),
  })
  .refine(
    (box) => box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001,
    "The box must lie inside the frame.",
  );

export const RegionSchema = z.object({
  effect: z
    .enum(REGION_EFFECTS)
    .describe(
      "zoom punches in so the box fills the frame; blur blurs inside or outside the box; highlight dims (and optionally blurs) everything outside the box",
    ),
  box: RegionBoxSchema.describe(
    "The region, in fractions of the composition frame (0 to 1, from the top left). A zoom's box keeps the frame's shape: width and height are the same fraction, and the zoom is 1/width",
  ),
  in: ramp.describe(
    "Frames from the clip's first frame over which the effect eases in; 0 starts it at full strength",
  ),
  out: ramp.describe(
    "Frames before the clip's last frame over which the effect eases back out; 0 holds it to the end",
  ),
  ease: z
    .enum(REGION_EASES)
    .describe(
      "The curve of both ramps: linear, ease, ease-in, ease-out, ease-in-out (smooth at both ends), expo-in (slow start, sharp finish) or expo-out (sharp start, slow finish)",
    ),
  blur: z
    .number()
    .min(0)
    .max(100)
    .describe("Blur radius in composition pixels, for blur and highlight"),
  dim: z
    .number()
    .min(0)
    .max(1)
    .describe("How dark highlight makes the outside: 0 leaves it, 1 is black"),
  area: z
    .enum(REGION_AREAS)
    .describe("Where blur applies: inside the box or outside it"),
  radius: z
    .number()
    .min(0)
    .max(2000)
    .describe(
      "Corner radius of the box in composition pixels, for blur and highlight",
    ),
  feather: z
    .number()
    .min(0)
    .max(500)
    .describe(
      "Softness of the box's edge in composition pixels, for blur and highlight",
    ),
});

/** A region change: fields left out keep their values. */
export const RegionEditSchema = RegionSchema.partial();

export type Region = z.output<typeof RegionSchema>;
export type RegionBox = Region["box"];
export type RegionEdit = z.output<typeof RegionEditSchema>;
export type RegionEffect = Region["effect"];
export type RegionEase = Region["ease"];
type Fps = { num: number; den: number };

/** Fractions are stored to six decimals, a millionth of the frame. */
const round = (value: number) => Number(value.toFixed(6)) + 0;
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * The zoom box for a requested region: the smallest box of the frame's shape that holds it,
 * centred on it, no closer than MAX_ZOOM, and moved inside the frame.
 */
export function fitZoomBox(box: RegionBox): RegionBox {
  const side = clamp(Math.max(box.width, box.height), 1 / MAX_ZOOM, 1);
  const centre = (start: number, length: number) =>
    clamp(start + length / 2 - side / 2, 0, 1 - side);
  return {
    x: round(centre(box.x, box.width)),
    y: round(centre(box.y, box.height)),
    width: round(side),
    height: round(side),
  };
}

const framesOf = (seconds: number, fps: Fps) =>
  Math.round((seconds * fps.num) / fps.den);

/** A new effect's settings: a 2x zoom on the centre, or a box a little right of it. */
export function defaultRegion(effect: RegionEffect, fps: Fps): Region {
  const zoom = effect === "zoom";
  return {
    effect,
    box: zoom
      ? { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
      : { x: 0.35, y: 0.35, width: 0.3, height: 0.3 },
    // A blur or highlight shows from the frame it is drawn on; a zoom eases in and out.
    in: zoom ? framesOf(0.5, fps) : 0,
    out: zoom ? framesOf(0.5, fps) : 0,
    ease: zoom ? "ease-in-out" : "ease",
    blur: effect === "blur" ? 16 : 0,
    dim: 0.6,
    area: "inside",
    radius: effect === "zoom" ? 0 : 12,
    feather: effect === "highlight" ? 8 : 0,
  };
}

/** A region with the edit's fields replaced, its box rounded and, for a zoom, fitted. */
export function editRegion(region: Region, edit: RegionEdit): Region {
  const next = { ...region, ...edit };
  const box = next.effect === "zoom" ? fitZoomBox(next.box) : next.box;
  return {
    ...next,
    box: {
      x: round(box.x),
      y: round(box.y),
      width: round(Math.min(box.width, 1 - box.x)),
      height: round(Math.min(box.height, 1 - box.y)),
    },
  };
}

/** How far a zoom magnifies the frame. */
export const zoomScale = (region: Region) => 1 / region.box.width;

/**
 * The two pieces of a region cut in two. The effect runs straight through the cut, so the left
 * piece keeps the ramp in, the right piece keeps the ramp out, and neither ramps at the cut.
 */
export const cutRegion = (region: Region): { left: Region; right: Region } => ({
  left: { ...region, out: 0 },
  right: { ...region, in: 0 },
});

/** Whether two regions hold the same settings. */
export const sameRegion = (a: Region | null, b: Region | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.effect === b.effect &&
    a.box.x === b.box.x &&
    a.box.y === b.box.y &&
    a.box.width === b.box.width &&
    a.box.height === b.box.height &&
    a.in === b.in &&
    a.out === b.out &&
    a.ease === b.ease &&
    a.blur === b.blur &&
    a.dim === b.dim &&
    a.area === b.area &&
    a.radius === b.radius &&
    a.feather === b.feather);
