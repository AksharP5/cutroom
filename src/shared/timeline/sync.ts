import { readClipSource, resolveClip } from "./clipTiming";
import {
  decimalFraction,
  decode,
  frames,
  nearestFrame,
  positionAtSource,
  sourceAt,
  subtract,
} from "./piece";
import type { Curve, SourceMap } from "./piece";
import { isAudioKind } from "./schema";
import type { Clip, Fps, Timeline } from "./schema";

type Line = SourceMap & { curve: Curve };

const sameCurve = (a: Curve, b: Curve) =>
  typeof a === "object" && typeof b === "object"
    ? JSON.stringify(a.points) === JSON.stringify(b.points)
    : typeof a !== "object" && typeof b !== "object" && Number(a) === Number(b);

/** Clips are immutable snapshots, so an edit decodes only the clips it changed. */
const lines = new WeakMap<Clip, { fps: Fps; line: Line }>();

/**
 * How many frames each linked clip has drifted from its picture or sound, as Resolve's
 * out-of-sync badge shows it: positive when the clip plays its source later than its partner.
 * Only linked picture and sound of the same file on the same speed or speed curve can drift;
 * clips in sync are left out. The drift is read from the two clips' source maps.
 */
export function syncOffsets({ clips, fps }: Pick<Timeline, "clips" | "fps">) {
  const groups = new Map<string, Clip[]>();
  for (const clip of clips)
    if (clip.link !== null && clip.mediaStart !== null)
      groups.set(clip.link, [...(groups.get(clip.link) ?? []), clip]);
  const lineOf = (clip: Clip) => {
    const known = lines.get(clip);
    if (known?.fps === fps) return known.line;
    const { stored, curve } = readClipSource(clip);
    const line = {
      ...decode(stored, curve, frames(clip.start, fps), fps),
      curve,
    };
    lines.set(clip, { fps, line });
    return line;
  };
  const frameUs = (1e6 * fps.den) / fps.num;
  const offsets = new Map<string, number>();
  for (const group of groups.values())
    for (const clip of group) {
      const own = lineOf(clip);
      const partner = group.find(
        (other) =>
          isAudioKind(other.kind) !== isAudioKind(clip.kind) &&
          other.src === clip.src &&
          sameCurve(lineOf(other).curve, own.curve),
      );
      if (!partner) continue;
      const other = lineOf(partner);
      // Two maps on one curve are one line shifted in time when their zeros agree, and at a
      // constant speed always: the shift is the distance between their curve zeros plus the
      // zeros' difference at that speed. A ramp whose zero moved is compared where this clip
      // starts, through the partner's inverse map.
      let offset: number;
      if (typeof own.curve === "object" && own.zero !== other.zero) {
        const start = frames(clip.start, fps);
        const there = positionAtSource(
          resolveClip(partner, fps),
          sourceAt(resolveClip(clip, fps), start),
        );
        offset = Number(nearestFrame(subtract(start, there), fps));
      } else {
        const rate =
          typeof own.curve === "object" ? null : decimalFraction(own.curve);
        const zeros = rate
          ? ((other.zero - own.zero) * Number(rate.d)) /
            (Number(rate.n) * frameUs)
          : 0;
        offset = Math.round(
          own.c - other.c + (own.tau - other.tau) / frameUs + zeros,
        );
      }
      if (offset) offsets.set(clip.id, offset);
    }
  return offsets;
}
