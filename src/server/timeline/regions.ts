import { toFrames, toSeconds } from "../../shared/timeline/apply";
import { RegionSchema } from "../../shared/timeline/region";
import type { Region } from "../../shared/timeline/region";
import type { Fps } from "../../shared/timeline/schema";

/** The attribute value for a region: its settings as JSON, with the ramps in seconds. */
export const regionAttribute = (region: Region, fps: Fps) =>
  JSON.stringify({
    ...region,
    in: toSeconds(region.in, fps),
    out: toSeconds(region.out, fps),
  });

/**
 * A region from its attribute, or null when it is absent or is not one Cutroom writes. Every value
 * passes the schema, so only numbers and named choices reach the stylesheet.
 */
export function readRegion(
  attribute: string | undefined,
  fps: Fps,
): Region | null {
  if (attribute === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(attribute);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const ramp = (name: "in" | "out") => {
    const seconds: unknown = Reflect.get(value, name);
    return typeof seconds === "number" ? toFrames(seconds, fps) : seconds;
  };
  const parsed = RegionSchema.safeParse({
    ...value,
    in: ramp("in"),
    out: ramp("out"),
  });
  return parsed.success ? parsed.data : null;
}
