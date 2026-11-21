import { sameRate } from "../../shared/projectFormat";
import type { ProjectFormat } from "../../shared/projectFormat";
import { normalizeTimeline, toFrames } from "../../shared/timeline/apply";
import { TimelineError } from "../../shared/timeline/errors";
import { clipName } from "../../shared/timeline/labels";
import {
  add,
  attrMicros,
  decodeLocal,
  frames,
  nearestFrame,
  secondsOf,
  subtract,
} from "../../shared/timeline/piece";
import type { ExactTime } from "../../shared/timeline/piece";
import { ClipSchema, TransitionSchema } from "../../shared/timeline/schema";
import type {
  TimelineSettings,
  Transition,
} from "../../shared/timeline/schema";
import { framesAfter, framesBefore } from "../../shared/timeline/transition";
import { formatWindows } from "./composition";
import type { ParsedComposition } from "./composition";
import { elementClip } from "./transitions";

export function planFormat(
  parsed: ParsedComposition,
  settings: TimelineSettings,
  lengths: ReadonlyMap<string, number>,
  format: ProjectFormat,
) {
  const before = parsed.timeline;
  const { fps } = format;
  const oldRate = before.fps;
  const preview = { movedEdges: 0, maxShiftMs: 0 };
  if (sameRate(oldRate, fps)) return { timeline: before, preview };

  const snap = (time: ExactTime) => Number(nearestFrame(time, fps));
  const local = (count: number) => snap(frames(count, oldRate));
  const authored = (seconds: number | string) =>
    decodeLocal(attrMicros(seconds), oldRate);
  const windows = new Map(
    formatWindows(parsed, lengths).map(
      ({ clipId, name, start, end, reference }) => {
        if (clipId === undefined || end === null)
          throw new TimelineError(
            "unsupported",
            `Cannot represent ${name} on the new frame grid.`,
          );
        return [clipId, { start, end, reference }];
      },
    ),
  );

  function edge(time: ExactTime) {
    const frame = snap(time);
    const shift = subtract(frames(frame, fps), time);
    if (shift.n) {
      preview.movedEdges++;
      preview.maxShiftMs = Math.max(
        preview.maxShiftMs,
        Math.abs(secondsOf(shift)) * 1000,
      );
    }
    return frame;
  }

  function retimeTransition(
    transition: Transition | null,
    cut: ExactTime,
    snappedCut: number,
    name: string,
  ) {
    if (!transition) return null;
    const before =
      snappedCut -
      snap(subtract(cut, frames(framesBefore(transition), oldRate)));
    const after =
      snap(add(cut, frames(framesAfter(transition), oldRate))) - snappedCut;
    const result = TransitionSchema.safeParse({
      ...transition,
      duration: before + after,
    });
    if (
      !result.success ||
      framesBefore(result.data) !== before ||
      framesAfter(result.data) !== after
    )
      throw new TimelineError(
        "unsupported",
        `The transition on ${name} cannot fit the new frame grid.`,
      );
    return result.data;
  }

  const clips = before.clips.map((clip) => {
    const window = windows.get(clip.id);
    const name = clipName(clip);
    if (!window)
      throw new TimelineError(
        "unsupported",
        `Cannot read the edges of ${name}.`,
      );
    const handle = frames(
      clip.transitionIn ? framesBefore(clip.transitionIn) : 0,
      oldRate,
    );
    const oldStart = add(window.start, handle);
    const oldEnd = subtract(
      window.end,
      frames(clip.transitionOut ? framesAfter(clip.transitionOut) : 0, oldRate),
    );
    const start = edge(oldStart);
    const end = edge(oldEnd);
    if (end <= start)
      throw new TimelineError(
        "out_of_bounds",
        `${name} would be shorter than one frame at the new rate.`,
      );

    const { keyframes, region, title } = clip;
    if (window.reference && !clip.startRef)
      throw new TimelineError(
        "unsupported",
        `Cannot preserve the referenced start on ${name}.`,
      );
    const next = {
      ...clip,
      start,
      duration: end - start,
      fadeIn: local(clip.fadeIn),
      fadeOut: local(clip.fadeOut),
      transitionIn: retimeTransition(clip.transitionIn, oldStart, start, name),
      transitionOut: retimeTransition(clip.transitionOut, oldEnd, end, name),
      keyframes:
        keyframes &&
        Object.fromEntries(
          Object.entries(keyframes).map(([property, points]) => [
            property,
            points.map((point) => ({ ...point, frame: local(point.frame) })),
          ]),
        ),
      region: region && {
        ...region,
        in: local(region.in),
        out: local(region.out),
      },
      title: title && {
        ...title,
        in: { ...title.in, frames: local(title.in.frames) },
        out: { ...title.out, frames: local(title.out.frames) },
      },
    };
    const validated = ClipSchema.safeParse(next);
    if (!validated.success)
      throw new TimelineError(
        "unsupported",
        `The timing controls on ${name} cannot fit the new frame grid.`,
      );
    const physical = elementClip(validated.data, fps);
    if (
      physical.start < 0 ||
      (physical.mediaStart !== null && physical.mediaStart < -1e-6)
    )
      throw new TimelineError(
        "out_of_bounds",
        `${name} needs more media before its start at the new rate.`,
      );
    const sourceEnd = physical.sourceDuration;
    if (
      sourceEnd !== null &&
      physical.mediaStart !== null &&
      parsed.elements.get(clip.id)?.attrs.loop === undefined &&
      !clip.automation
    ) {
      const previous = elementClip(clip, oldRate);
      const playable = toFrames(
        (sourceEnd - physical.mediaStart) / clip.playbackRate,
        fps,
      );
      const wasPlayable =
        previous.duration <=
        toFrames(
          (sourceEnd - (previous.mediaStart ?? 0)) / clip.playbackRate,
          oldRate,
        );
      if (physical.duration > playable && wasPlayable)
        throw new TimelineError(
          "out_of_bounds",
          `${name} would run past the end of its media at the new rate.`,
        );
    }
    return validated.data;
  });

  const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  const retimed = clips.map((clip) => {
    if (!clip.startRef) return clip;
    const target = clipsById.get(clip.startRef.clipId);
    if (!target)
      throw new TimelineError(
        "unsupported",
        `Cannot preserve the referenced start on ${clipName(clip)}.`,
      );
    const targetEnd =
      target.start +
      target.duration +
      (target.transitionOut ? framesAfter(target.transitionOut) : 0);
    return {
      ...clip,
      startRef: { clipId: target.id, offset: clip.start - targetEnd },
    };
  });

  const mark = (time: number | null) =>
    time === null ? null : snap(authored(time));
  const { in: inPoint, out: outPoint } = settings.range;
  const range = { in: mark(inPoint), out: mark(outPoint) };
  if (range.in !== null && range.out !== null && range.out <= range.in)
    throw new TimelineError(
      "out_of_bounds",
      "In and Out would land on the same frame.",
    );
  const duration = parsed.rootDurationAuthored
    ? snap(authored(parsed.root.attrs["data-duration"]!))
    : clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
  if (parsed.rootDurationAuthored && duration === 0)
    throw new TimelineError(
      "out_of_bounds",
      "The composition would be shorter than one frame at the new rate.",
    );
  const markers = settings.markers.map(({ time, duration, ...marker }) => {
    const start = authored(time);
    const frame = snap(start);
    return {
      ...marker,
      frame,
      duration: snap(add(start, authored(duration))) - frame,
    };
  });
  return {
    timeline: normalizeTimeline({
      ...before,
      fps,
      clips: retimed,
      duration,
      range,
      markers,
    }),
    preview,
  };
}
