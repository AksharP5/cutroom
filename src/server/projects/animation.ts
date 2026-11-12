import { z } from "zod";
import type { Clip, Timeline } from "../../shared/timeline/schema";
import type { TweenWindows } from "../../shared/preview";
import { toSeconds } from "../../shared/timeline/apply";

// Evidence belongs to a particular edit, never to the lifetime of a clip or tween.
const AnimationEvidenceSchema = z.object({
  key: z.string(),
  starts: z.array(z.number().finite()),
  origin: z.number().finite(),
});
export const AnimationResultSchema = z.object({
  clipId: z.string(),
  evidence: z.array(AnimationEvidenceSchema),
});
export const AnimationEditSchema = z.object({
  historyId: z.string(),
  composition: z.string(),
  results: z.array(AnimationResultSchema),
});
export type AnimationResult = z.infer<typeof AnimationResultSchema>;
export type AnimationSnapshot = { timeline: Timeline; windows: TweenWindows };
export type AnimationCheck = {
  clipId: string;
  sourceId: string;
  source: AnimationSnapshot;
};

export function clipOrigin(clip: Clip, timeline: Timeline) {
  return (
    toSeconds(clip.start, timeline.fps) -
    (clip.mediaStart ?? clip.animationInPoint ?? 0) / clip.playbackRate
  );
}

const pairs = (windows: TweenWindows, id: string) =>
  Object.hasOwn(windows, id) ? windows[id]! : [];

/** Equal multisets prove a correspondence without depending on tween order or duration. */
function sameStarts(before: number[], after: number[], delta = 0) {
  if (!before.length || before.length !== after.length) return false;
  const a = before.toSorted((a, b) => a - b);
  const b = after.toSorted((a, b) => a - b);
  return a.every((start, i) => Math.abs(start + delta - b[i]!) <= 0.002);
}

/** Source edits can resolve an existing warning, but only an origin-changing edit creates one. */
export function checkAnimationEdit(
  after: AnimationSnapshot,
  checks: AnimationCheck[],
  previous: AnimationResult[],
): AnimationResult[] {
  const results = new Map<string, AnimationResult>();
  const clips = new Map(after.timeline.clips.map((clip) => [clip.id, clip]));
  for (const result of previous) {
    const clip = clips.get(result.clipId);
    if (!clip) continue;
    const groups = new Map(pairs(after.windows, clip.id));
    const origin = clipOrigin(clip, after.timeline);
    results.set(clip.id, {
      clipId: clip.id,
      evidence: result.evidence.filter((evidence) => {
        const delta = origin - evidence.origin;
        const starts = groups.get(evidence.key);
        return (
          Math.abs(delta) > 0.002 &&
          starts !== undefined &&
          sameStarts(evidence.starts, starts) &&
          !sameStarts(evidence.starts, starts, delta)
        );
      }),
    });
  }
  for (const check of checks) {
    const clip = clips.get(check.clipId);
    const source = check.source.timeline.clips.find(
      (clip) => clip.id === check.sourceId,
    );
    if (!clip || !source) continue;
    const origin = clipOrigin(source, check.source.timeline);
    const delta = clipOrigin(clip, after.timeline) - origin;
    if (Math.abs(delta) <= 0.002) continue;
    const groups = new Map(pairs(after.windows, clip.id));
    const known = new Set(
      previous
        .find((result) => result.clipId === clip.id)
        ?.evidence.map(({ key }) => key),
    );
    const result = results.get(clip.id) ?? { clipId: clip.id, evidence: [] };
    for (const [key, starts] of pairs(check.source.windows, source.id)) {
      const next = groups.get(key);
      if (
        !known.has(key) &&
        next &&
        sameStarts(starts, next) &&
        !sameStarts(starts, next, delta)
      )
        result.evidence.push({ key, starts, origin });
    }
    results.set(clip.id, result);
  }
  return [...results.values()];
}

export function animationWarnings(results: AnimationResult[]) {
  return results.flatMap(({ clipId, evidence }) =>
    evidence.length
      ? [
          {
            clipId,
            time: Math.min(...evidence.flatMap(({ starts }) => starts)),
          },
        ]
      : [],
  );
}
