import { sameRate } from "../../shared/projectFormat";
import type { ProjectFormat } from "../../shared/projectFormat";
import { normalizeTimeline } from "../../shared/timeline/apply";
import { resolveClip, sourceAtEdge } from "../../shared/timeline/clipTiming";
import { TimelineError } from "../../shared/timeline/errors";
import { clipName } from "../../shared/timeline/labels";
import {
  add,
  attrMicros,
  decodeLocal,
  firstFrame,
  frames,
  micros,
  nearestFrame,
  positionAtSource,
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

  function measure(time: ExactTime, frame: number, clipEdge = false) {
    const shift = subtract(frames(frame, fps), time);
    if (shift.n) {
      if (clipEdge) preview.movedEdges++;
      preview.maxShiftMs = Math.max(
        preview.maxShiftMs,
        Math.abs(secondsOf(shift)) * 1000,
      );
    }
    return frame;
  }

  const local = (count: number, minimum = 0) => {
    const time = frames(count, oldRate);
    return measure(time, Math.max(minimum, snap(time)));
  };

  function retimeTransition(
    transition: Transition | null,
    cut: ExactTime,
    snappedCut: number,
    name: string,
  ) {
    if (!transition) return null;
    const oldStart = subtract(cut, frames(framesBefore(transition), oldRate));
    const oldEnd = add(cut, frames(framesAfter(transition), oldRate));
    const before = snappedCut - measure(oldStart, snap(oldStart));
    const after = measure(oldEnd, snap(oldEnd)) - snappedCut;
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
    let start = snap(oldStart);
    let end = snap(oldEnd);
    const piece = clip.mediaStart !== null && resolveClip(clip, oldRate, true);
    const sourceStart = piece && positionAtSource(piece, micros(-1));
    const sourceEnd =
      piece &&
      clip.sourceDuration !== null &&
      parsed.elements.get(clip.id)?.attrs.loop === undefined &&
      positionAtSource(piece, micros(attrMicros(clip.sourceDuration) + 1n));
    // The old grid could show the last partial source frame. Fit that
    // interval to the new grid, while keeping intentional source overhangs.
    const playableEnd =
      sourceEnd &&
      firstFrame(window.end, oldRate) <= firstFrame(sourceEnd, oldRate) &&
      sourceEnd;
    // A nearest edge can extend a trim outside the source. Snap inward
    // when there is no media left on that side.
    if (sourceStart && subtract(frames(start, fps), sourceStart).n < 0n)
      start++;
    if (playableEnd && subtract(frames(end, fps), playableEnd).n > 0n) {
      const nearest = snap(playableEnd);
      end =
        subtract(frames(nearest, fps), playableEnd).n > 0n
          ? nearest - 1
          : nearest;
    }
    measure(oldStart, start, true);
    measure(oldEnd, end, true);
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
    const source = sourceAtEdge(
      clip,
      frames(clip.start, oldRate),
      frames(start, fps),
      oldRate,
      fps,
    );
    // The speed span records a prior edit in units of the old frame grid.
    const { speedSpan: _speedSpan, ...original } = clip;
    const fadeIn = local(clip.fadeIn, clip.fadeIn > 0 ? 1 : 0);
    const fadeOut = local(clip.fadeOut, clip.fadeOut > 0 ? 1 : 0);
    if (fadeIn)
      measure(add(oldStart, frames(clip.fadeIn, oldRate)), start + fadeIn);
    if (fadeOut)
      measure(subtract(oldEnd, frames(clip.fadeOut, oldRate)), end - fadeOut);
    const next = {
      ...original,
      ...source,
      // The source map is stored in whole microseconds.
      mediaStart:
        source.mediaStart !== null && source.mediaStart >= -1e-6
          ? Math.max(0, source.mediaStart)
          : source.mediaStart,
      start,
      duration: end - start,
      fadeIn,
      fadeOut,
      transitionIn: retimeTransition(clip.transitionIn, oldStart, start, name),
      transitionOut: retimeTransition(clip.transitionOut, oldEnd, end, name),
      keyframes:
        keyframes &&
        Object.fromEntries(
          Object.entries(keyframes).map(([property, points]) => {
            let previousFrame: number | undefined;
            return [
              property,
              points.map((point, index) => {
                const time = add(oldStart, frames(point.frame, oldRate));
                const frame = measure(time, snap(time)) - start;
                if (previousFrame === frame)
                  throw new TimelineError(
                    "unsupported",
                    `${name} has ${property} keyframes at clip frames ${points[index - 1]!.frame} and ${point.frame} that both land on frame ${frame} at the new rate.`,
                  );
                previousFrame = frame;
                return { ...point, frame };
              }),
            ];
          }),
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
    if (
      playableEnd &&
      subtract(frames(physical.start + physical.duration, fps), playableEnd).n >
        0n
    )
      throw new TimelineError(
        "out_of_bounds",
        `The transition on ${name} needs more media after its end at the new rate.`,
      );
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

  const mark = (time: number | null) => {
    if (time === null) return null;
    const position = authored(time);
    return measure(position, snap(position));
  };
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
    const end = add(start, authored(duration));
    const frame = measure(start, snap(start));
    return {
      ...marker,
      frame,
      duration: measure(end, snap(end)) - frame,
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
