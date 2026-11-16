import { isAudioKind } from "./schema";
import type { Clip, Timeline } from "./schema";

/**
 * How many frames each linked clip has drifted from its picture or sound, as Resolve's
 * out-of-sync badge shows it: positive when the clip plays its source later than its partner.
 * Only linked picture and sound of the same file at the same speed can drift; clips in sync are
 * left out.
 */
export function syncOffsets({ clips, fps }: Pick<Timeline, "clips" | "fps">) {
  const groups = new Map<string, Clip[]>();
  for (const clip of clips)
    if (clip.link !== null && clip.mediaStart !== null)
      groups.set(clip.link, [...(groups.get(clip.link) ?? []), clip]);
  const frame = fps.den / fps.num;
  /** The source second this clip plays at the timeline's first frame, at its own speed. */
  const origin = (clip: Clip) =>
    clip.mediaStart! - clip.start * frame * clip.playbackRate;
  const offsets = new Map<string, number>();
  for (const group of groups.values())
    for (const clip of group) {
      const partner = group.find(
        (other) =>
          isAudioKind(other.kind) !== isAudioKind(clip.kind) &&
          other.src === clip.src &&
          other.playbackRate === clip.playbackRate,
      );
      if (!partner) continue;
      const offset = Math.round(
        (origin(partner) - origin(clip)) / (frame * clip.playbackRate),
      );
      if (offset) offsets.set(clip.id, offset);
    }
  return offsets;
}
