import {
  parseAutomation,
  RATE_TARGET,
  serializeAutomation,
} from "@hyperframes/core/audio-automation";
import {
  attrMicros,
  decode,
  encode,
  firstFrame,
  frames,
  micros,
  positionAtSource,
  rampSourceTimes,
  regridSourceMap,
  resolvePiece,
} from "./piece";
import type { ExactTime, Piece, StoredSource } from "./piece";
import type { Clip, Fps } from "./schema";
import { framesAfter, framesBefore, takesTransition } from "./transition";

type SourceFields = Pick<Clip, "mediaStart" | "playbackRate" | "automation">;

const automationCache = new Map<
  string,
  ReturnType<typeof parseClipAutomation>
>();

function parseClipAutomation(automation: string) {
  const parsed = parseAutomation(automation);
  return {
    parsed,
    lane: parsed.lanes.find(({ target }) => target === RATE_TARGET),
  };
}

/** Keep point arrays stable so HyperFrames can reuse its cached ramp integrals. */
function clipAutomation(automation: string) {
  const cached = automationCache.get(automation);
  if (cached) return cached;
  const result = parseClipAutomation(automation);
  automationCache.set(automation, result);
  if (automationCache.size > 4096) {
    const oldest = automationCache.keys().next();
    if (!oldest.done) automationCache.delete(oldest.value);
  }
  return result;
}

/** The lane's offset belongs to its stored in-point, never to the resolver's curve. */
export function readClipSource({
  mediaStart,
  playbackRate,
  automation,
}: SourceFields) {
  const { parsed, lane } = automation
    ? clipAutomation(automation)
    : { parsed: null, lane: undefined };
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
  edgeFps = fps,
) {
  if (fields.mediaStart === null)
    return { mediaStart: null, automation: fields.automation };
  const source = readClipSource(fields);
  const map = decode(source.stored, source.curve, authored, fps);
  return writeClipSource(
    source,
    encode(
      edgeFps === fps ? map : regridSourceMap(map, source.curve, fps, edgeFps),
      source.curve,
      edge,
      edgeFps,
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

/** Whole frames of media a clip has after its out point; unbounded for stills and unmeasured media. */
export function framesAfterOut(clip: Clip, fps: Fps) {
  if (clip.mediaStart === null || clip.sourceDuration === null) return Infinity;
  const line = resolveClip(clip, fps);
  const end = positionAtSource(line, micros(attrMicros(clip.sourceDuration)));
  return Number(firstFrame(end, fps)) - (clip.start + clip.duration);
}

/** Whole frames of media a clip has before its in point. */
export function framesBeforeIn(clip: Clip, fps: Fps) {
  if (clip.mediaStart === null) return Infinity;
  const line = resolveClip(clip, fps);
  const start = Number(firstFrame(positionAtSource(line, micros(0)), fps));
  // A handle must encode a nonnegative in-point in the document.
  return (
    clip.start -
    start -
    (encode(line, line.curve, frames(start, fps), fps).mediaStart < 0 ? 1 : 0)
  );
}

const rampPieces = new WeakMap<Clip, { fps: Fps; piece: Piece }>();

/**
 * Source seconds a ramped clip plays at `count` positions `step` timeline seconds apart, from
 * `from` frames into the clip, on the curve every other consumer reads. Null at a constant
 * speed, whose source is a straight line from its in-point.
 */
export function rampSourceSeconds(
  clip: Clip,
  fps: Fps,
  from: number,
  step: number,
  count: number,
) {
  if (!clip.automation || !readClipSource(clip).lane) return null;
  let held = rampPieces.get(clip);
  if (held?.fps !== fps) {
    // What a clip plays from its own first frame does not depend on where it sits, and a clip
    // the timeline is sliding between places can sit between frames.
    held = { fps, piece: resolveClip({ ...clip, start: 0 }, fps) };
    rampPieces.set(clip, held);
  }
  return rampSourceTimes(
    held.piece,
    micros(Math.round(((from * fps.den) / fps.num) * 1e6)),
    step,
    count,
  );
}
