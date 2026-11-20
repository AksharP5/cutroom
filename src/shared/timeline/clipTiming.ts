import {
  parseAutomation,
  RATE_TARGET,
  serializeAutomation,
} from "@hyperframes/core/audio-automation";
import {
  attrMicros,
  decode,
  encode,
  frames,
  micros,
  resolvePiece,
} from "./piece";
import type { ExactTime, StoredSource } from "./piece";
import type { Clip, Fps } from "./schema";
import { framesAfter, framesBefore, takesTransition } from "./transition";

type SourceFields = Pick<Clip, "mediaStart" | "playbackRate" | "automation">;

/** The lane's offset belongs to its stored in-point, never to the resolver's curve. */
export function readClipSource({
  mediaStart,
  playbackRate,
  automation,
}: SourceFields) {
  const parsed = automation ? parseAutomation(automation) : null;
  const lane = parsed?.lanes.find(({ target }) => target === RATE_TARGET);
  const curve = lane
    ? { target: lane.target, points: lane.points }
    : playbackRate;
  const stored = {
    mediaStart: Number(attrMicros(mediaStart ?? 0)),
    ...(lane?.offset !== undefined && {
      offset: Number(attrMicros(lane.offset)),
    }),
  };
  return { parsed, lane, curve, stored };
}

export function writeClipSource(
  source: ReturnType<typeof readClipSource>,
  stored: StoredSource,
) {
  const { parsed, lane } = source;
  return {
    mediaStart: stored.mediaStart / 1e6,
    automation: parsed
      ? serializeAutomation({
          ...parsed,
          lanes: parsed.lanes.map((candidate) =>
            candidate === lane
              ? {
                  target: lane.target,
                  points: lane.points,
                  ...(stored.offset && { offset: stored.offset / 1e6 }),
                }
              : candidate,
          ),
        })
      : null,
  };
}

/** Start a new source line at the clip's current timeline frame. */
export function retimeClipSource(
  fields: SourceFields,
  start: number,
  fps: Fps,
) {
  return sourceAtEdge(fields, frames(start, fps), frames(start, fps), fps);
}

/** Project an authored source or a Clip onto a new edge, keeping its source map. */
export function sourceAtEdge(
  fields: SourceFields,
  authored: ExactTime,
  edge: ExactTime,
  fps: Fps,
) {
  if (fields.mediaStart === null)
    return { mediaStart: null, automation: fields.automation };
  const source = readClipSource(fields);
  return writeClipSource(
    source,
    encode(
      decode(source.stored, source.curve, authored, fps),
      source.curve,
      edge,
      fps,
    ),
  );
}

export function elementBounds(clip: Clip) {
  const before =
    takesTransition(clip) && clip.transitionIn
      ? framesBefore(clip.transitionIn)
      : 0;
  const after =
    takesTransition(clip) && clip.transitionOut
      ? framesAfter(clip.transitionOut)
      : 0;
  return {
    start: clip.start - before,
    end: clip.start + clip.duration + after,
  };
}

/** Resolve the editor's frame-grid projection, with or without its transition handles. */
export function resolveClip(clip: Clip, fps: Fps, physical = false) {
  const at = frames(clip.start, fps);
  const bounds = physical
    ? elementBounds(clip)
    : { start: clip.start, end: clip.start + clip.duration };
  const window = {
    start: frames(bounds.start, fps),
    end: frames(bounds.end, fps),
  };
  const source = readClipSource(clip);
  return resolvePiece(
    {
      id: clip.id,
      path: `/${clip.id}`,
      src: clip.src ?? "",
      ownFps: fps,
      origin: micros(0),
      edge: window,
      local: window,
      curve: source.curve,
      stored:
        bounds.start === clip.start
          ? source.stored
          : encode(
              decode(source.stored, source.curve, at, fps),
              source.curve,
              window.start,
              fps,
            ),
    },
    fps,
  );
}
