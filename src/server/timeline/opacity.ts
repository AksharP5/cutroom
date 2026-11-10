import { transformStyleAttribute } from "lightningcss";
import { TimelineError } from "../../shared/timeline/apply";

/** Only a numeric inline opacity is a static value. Stylesheets and expressions stay authored. */
export function readOpacity(style: string | undefined): number | null {
  if (!style) return null;
  let opacity: number | null = null;
  try {
    transformStyleAttribute({
      code: Buffer.from(style),
      visitor: {
        Declaration(declaration) {
          if (declaration.property === "opacity")
            opacity = Math.max(
              0,
              Math.min(1, Math.round(declaration.value * 1e6) / 1e6),
            );
          if (
            declaration.property === "unparsed" &&
            declaration.value.propertyId.property === "opacity"
          )
            opacity = null;
        },
      },
    });
  } catch {
    // Invalid authored CSS must not prevent reading or repairing the timeline.
    return null;
  }
  return opacity;
}

export function writeOpacity(
  style: string | undefined,
  opacity: number | null,
): string | null {
  try {
    const result = transformStyleAttribute({
      code: Buffer.from(style ?? ""),
      visitor: {
        Declaration(declaration) {
          if (
            declaration.property === "opacity" ||
            (declaration.property === "unparsed" &&
              declaration.value.propertyId.property === "opacity")
          )
            return [];
        },
      },
    });
    const rest = Buffer.from(result.code).toString();
    return (
      [rest, opacity === null ? "" : `opacity: ${opacity}`]
        .filter(Boolean)
        .join("; ") || null
    );
  } catch {
    throw new TimelineError(
      "unsupported",
      "This clip has invalid inline CSS. Repair its source before changing opacity.",
    );
  }
}
