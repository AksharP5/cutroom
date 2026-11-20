import { parseRateLane, sourceTimeAt } from "@hyperframes/core/speed-ramp";
import { isAudioKind } from "./schema";
import type { Clip, Timeline } from "./schema";

/**
 * How many frames each linked clip has drifted from its picture or sound, as Resolve's
 * out-of-sync badge shows it: positive when the clip plays its source later than its partner.
 * The badge applies to constant speeds and to ramps that map the same curve to the same source.
 * Those edits can be brought back in sync by a single timeline shift.
 */
export function syncOffsets({ clips, fps }: Pick<Timeline, "clips" | "fps">) {
  const groups = new Map<string, Clip[]>();
  for (const clip of clips)
    if (clip.link !== null && clip.mediaStart !== null)
      groups.set(clip.link, [...(groups.get(clip.link) ?? []), clip]);
  const frame = fps.den / fps.num;
  const offsets = new Map<string, number>();
  for (const group of groups.values()) {
    const clocks = group.map((clip) => {
      const rate = parseRateLane(clip.automation);
      return rate
        ? {
            clip,
            shape: JSON.stringify(rate.points),
            source: clip.mediaStart! + sourceTimeAt(rate, -(rate.offset ?? 0)),
            timeline: clip.start * frame - (rate.offset ?? 0),
          }
        : {
            clip,
            shape: clip.playbackRate,
            source: 0,
            timeline: clip.start * frame - clip.mediaStart! / clip.playbackRate,
          };
    });
    for (const clock of clocks) {
      const partner = clocks.find(
        (other) =>
          isAudioKind(other.clip.kind) !== isAudioKind(clock.clip.kind) &&
          other.clip.src === clock.clip.src &&
          other.shape === clock.shape &&
          Math.abs(other.source - clock.source) < 1e-6,
      );
      if (!partner) continue;
      const offset = Math.round((clock.timeline - partner.timeline) / frame);
      if (offset) offsets.set(clock.clip.id, offset);
    }
  }
  return offsets;
}
