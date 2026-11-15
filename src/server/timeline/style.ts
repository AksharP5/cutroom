import { transformStyleAttribute } from "lightningcss";
import type { Declaration } from "lightningcss";
import { z } from "zod";
import { CropSchema } from "../../shared/timeline/schema";
import type { Clip } from "../../shared/timeline/schema";
import { transformStyle } from "../../shared/timeline/transform";
import type { ClipTransform } from "../../shared/timeline/transform";

type ClipStyle = Pick<Clip, "opacity"> & ClipTransform;
const OWNED = ["opacity", "scale", "rotate", "clip-path"] as const;
type Owned = (typeof OWNED)[number];

const owned = (declaration: Declaration): Owned | null => {
  const property =
    declaration.property === "unparsed"
      ? declaration.value.propertyId.property
      : declaration.property;
  return OWNED.find((name) => name === property) ?? null;
};
/** Lightning CSS reads numbers as 32-bit floats; the schema's precision is coarser. */
const round = (value: number, decimals: number) =>
  Number(value.toFixed(decimals)) + 0;
const DEGREES = { deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 } as const;
const RotateSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  angle: z.object({
    type: z.enum(["deg", "rad", "grad", "turn"]),
    value: z.number(),
  }),
});

/**
 * Reads the static inline values Cutroom owns. Stylesheets and expressions stay authored:
 * opacity reads as null, and a transform Cutroom cannot read or rewrite exactly gives the
 * reason it stays source-only.
 */
export function readClipStyle(style: string | undefined): ClipStyle & {
  restriction?: string;
} {
  const read: ClipStyle & { restriction?: string } = {
    opacity: null,
    scaleX: null,
    scaleY: null,
    rotation: null,
    crop: null,
  };
  if (!style) return read;
  const refuse = (what: string) => {
    read.restriction = `Cutroom can't edit this clip's inline ${what}. Change it in the source.`;
  };
  try {
    transformStyleAttribute({
      code: Buffer.from(style),
      visitor: {
        Declaration(declaration) {
          const property = owned(declaration);
          if (declaration.property === "opacity") {
            read.opacity = Math.max(
              0,
              Math.min(1, round(declaration.value, 6)),
            );
            return;
          }
          if (declaration.property === "scale") {
            const { value } = declaration;
            if (value === "none") return;
            const [x, y, z] = [value.x, value.y, value.z].map((axis) =>
              axis.type === "number" ? round(axis.value, 4) : NaN,
            );
            if (
              z !== 1 ||
              !(x! >= 0.01 && x! <= 100 && y! >= 0.01 && y! <= 100)
            )
              return refuse("scale");
            read.scaleX = x!;
            read.scaleY = y!;
            return;
          }
          if (declaration.property === "rotate") {
            if (declaration.value === "none") return;
            // The bundled types nest the axes under `xyz`; the parser returns them flat.
            const rotate = RotateSchema.safeParse(declaration.value);
            const degrees = rotate.success
              ? round(
                  rotate.data.angle.value * DEGREES[rotate.data.angle.type],
                  2,
                )
              : NaN;
            if (
              !rotate.success ||
              rotate.data.x ||
              rotate.data.y ||
              rotate.data.z !== 1 ||
              !(Math.abs(degrees) <= 3600)
            )
              return refuse("rotation");
            read.rotation = degrees || null;
            return;
          }
          if (declaration.property === "clip-path") {
            const { value } = declaration;
            if (value.type === "none") return;
            const inset =
              value.type === "shape" &&
              value.shape.type === "inset" &&
              value.referenceBox === "border-box"
                ? value.shape.value
                : null;
            const pixels = inset?.rect.map((edge) =>
              edge.type === "dimension" && edge.value.unit === "px"
                ? edge.value.value
                : NaN,
            );
            const corners = inset
              ? Object.values(inset.radius).flatMap((corner) =>
                  corner.map((size: (typeof corner)[number]) =>
                    size.type === "dimension" ? size.value.value : NaN,
                  ),
                )
              : [];
            const crop =
              pixels &&
              corners.every((size) => size === 0) &&
              CropSchema.safeParse({
                top: pixels[0],
                right: pixels[1],
                bottom: pixels[2],
                left: pixels[3],
              });
            if (!crop || !crop.success) return refuse("clip-path");
            read.crop = Object.values(crop.data).some(Boolean)
              ? crop.data
              : null;
            return;
          }
          // `var()` and other unparsed values are authored expressions.
          if (property === "opacity") read.opacity = null;
          else if (property)
            refuse(property === "rotate" ? "rotation" : property);
        },
      },
    });
  } catch {
    // Invalid authored CSS must not prevent reading or repairing the timeline.
    return {
      opacity: null,
      scaleX: null,
      scaleY: null,
      rotation: null,
      crop: null,
    };
  }
  return read;
}

/** The owned declarations a clip's values write; null leaves one out. */
export const clipStyle = (clip: ClipStyle): Record<Owned, string | null> => ({
  opacity: clip.opacity === null ? null : String(clip.opacity),
  ...transformStyle(clip),
});

/** Top-level declarations of a style attribute, split outside strings and parentheses. */
function declarations(style: string) {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let part = "";
  for (const char of style) {
    if (quote) quote = char === quote ? "" : quote;
    else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && !depth) {
      parts.push(part);
      part = "";
      continue;
    }
    part += char;
  }
  return [...parts, part].map((item) => item.trim()).filter(Boolean);
}

/**
 * Rewrites only the owned declarations that changed and keeps every other declaration as
 * written. Re-serializing through a CSS parser would fold `rotate` into `transform`, which
 * reverses their order, and round authored numbers.
 */
export function writeClipStyle(
  style: string | undefined,
  changes: Partial<Record<Owned, string | null>>,
): string | null {
  const kept = declarations(style ?? "").filter((declaration) => {
    const name = declaration
      .slice(0, declaration.indexOf(":"))
      .trim()
      .toLowerCase();
    return !Object.hasOwn(changes, name);
  });
  const written = Object.entries(changes).flatMap(([property, value]) =>
    value === null ? [] : [`${property}: ${value}`],
  );
  return [...kept, ...written].join("; ") || null;
}
