import { isAudioKind } from "./schema";
import type { Clip, Fps, Timeline } from "./schema";
import { KEYFRAME_ANIMATION } from "./keyframes";
import { REGION_EASE_CURVES } from "./region";
import type { Region } from "./region";
import { framesAfter, framesBefore, takesTransition } from "./transition";

/** A clip's region, as JSON with its ramps in seconds. */
export const REGION_ATTRIBUTE = "data-cutroom-region";
/** Marks an adjustment layer: an empty clip whose region draws over the tracks below it. */
export const ADJUSTMENT_ATTRIBUTE = "data-cutroom-adjustment";
export const REGION_STYLE_ATTRIBUTE = "data-cutroom-region-style";

/**
 * A zoom moves each picture it magnifies toward the viewer, through the `translate` longhand
 * added onto whatever the clip's own position and keyframes draw, under a perspective on the
 * picture's parent. Depth scales a picture about the perspective origin whatever its own place,
 * size or rotation, so one rule zooms a full-frame recording, a moved inset and a whole scene alike.
 */
const PERSPECTIVE = 1000;

/**
 * The animations every clip with a region runs after its own: an adjustment layer's fade in and
 * out, then the zoom of the picture it belongs to. Keyframes, titles and transitions list these
 * last, so a zoom adds onto their motion instead of replacing it.
 */
export const REGION_ANIMATION = {
  name: "var(--cutroom-fade,none),var(--cutroom-zoom,none)",
  duration: "var(--cutroom-fade-duration,1s),var(--cutroom-zoom-duration,1s)",
  delay: "0s,var(--cutroom-zoom-delay,0s)",
  iterations: "1,var(--cutroom-zoom-iterations,1)",
  fill: "both,both",
  timing: "linear,linear",
  composition: "replace,add",
};

const number = (value: number) => String(Number(value.toFixed(6)) + 0);
const seconds = (frames: number, fps: Fps) =>
  `${number((frames * fps.den) / fps.num)}s`;

/** A CSS string; `<` is escaped too, so an id can never close the style element. */
const cssString = (value: string) =>
  `"${value.replace(/[\0-\x1f\x7f"\\<]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)}"`;
const byId = (id: string) => `[id=${cssString(id)}]`;

/** A short stable name for generated keyframes. */
function hash(text: string) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(36);
}

/** The frames an element plays: a clip under a transition starts before its cut and ends after. */
export function elementSpan(clip: Clip) {
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

interface Segment {
  /** Frames from the start of the animation, end exclusive. */
  start: number;
  end: number;
  region: Region;
}
interface Key {
  frame: number;
  value: string;
  timing: string;
}

const easing = (region: Region) =>
  `cubic-bezier(${REGION_EASE_CURVES[region.ease].join(",")})`;

/**
 * Keyframes that show `on` through each segment, eased in over its first `in` frames and out over
 * its last `out`, and `off` elsewhere. Where a ramp is 0 the value changes on that frame, and the
 * frame before holds the old one. Where two segments overlap, the later one takes over at its start.
 */
function piecewise(
  segments: Segment[],
  off: string,
  on: (region: Region) => string,
): Key[] {
  const keys: Key[] = [{ frame: 0, value: off, timing: "linear" }];
  const last = () => keys.at(-1)!;
  const hold = (frame: number) => {
    if (frame > last().frame)
      keys.push({ frame, value: last().value, timing: "linear" });
  };
  const ramp = (frame: number, value: string, timing: string) => {
    last().timing = timing;
    keys.push({ frame, value, timing: "linear" });
  };
  const jump = (frame: number, value: string) => {
    if (frame <= last().frame) {
      last().value = value;
      return;
    }
    hold(frame - 1);
    last().timing = "steps(1,end)";
    keys.push({ frame, value, timing: "linear" });
  };
  const sorted = segments.toSorted((a, b) => a.start - b.start);
  sorted.forEach(({ start, end: own, region }, index) => {
    const end = Math.min(own, sorted[index + 1]?.start ?? own);
    if (end <= start) return;
    const value = on(region);
    const length = own - start;
    const rampOut = Math.min(region.out, length);
    // Without a ramp out, the effect reaches full strength before its last frame.
    const rampIn = Math.min(region.in, length - rampOut - (rampOut ? 0 : 1));
    if (rampIn > 0 && start + rampIn <= end) {
      hold(start);
      ramp(start + rampIn, value, easing(region));
    } else jump(start, value);
    if (end === own && rampOut > 0) {
      hold(own - rampOut);
      ramp(own, off, easing(region));
      return;
    }
    hold(end - 1);
    jump(end, off);
  });
  return keys;
}

function keyframes(prefix: string, keys: Key[], property: string) {
  const length = keys.at(-1)!.frame || 1;
  const body = keys
    .map(
      (key) =>
        `${number((key.frame / length) * 100)}%{${property}:${key.value};animation-timing-function:${key.timing}}`,
    )
    .join("");
  const name = `${prefix}-${hash(body)}`;
  return { name, length, rule: `@keyframes ${name}{${body}}` };
}

/** The `translate` that zooms a picture so the region's box fills a frame of this size. */
function zoomTranslate(
  region: Region,
  size: { width: number; height: number },
) {
  const { x, y, width } = region.box;
  const share = 1 - width;
  return `${number((size.width / 2) * share - x * size.width)}px ${number((size.height / 2) * share - y * size.height)}px ${number(PERSPECTIVE * share)}px`;
}

const px = (value: number) => `${number(value)}px`;

/** A rounded rectangle as path commands, its corners no rounder than half its shorter side. */
function roundedRect(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  const n = (value: number) => number(value);
  if (!radius) return `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`;
  const arc = (toX: number, toY: number) =>
    `A${n(radius)} ${n(radius)} 0 0 1 ${n(toX)} ${n(toY)}`;
  return (
    `M${n(x + radius)} ${n(y)}H${n(x + w - radius)}${arc(x + w, y + radius)}` +
    `V${n(y + h - radius)}${arc(x + w - radius, y + h)}` +
    `H${n(x + radius)}${arc(x, y + h - radius)}` +
    `V${n(y + radius)}${arc(x + radius, y)}Z`
  );
}

/**
 * Where a blur or highlight draws: the box, or everything outside it. A sharp edge is a clip path
 * with rounded corners; a feathered one is a pair of gradients across the box's edges, whose
 * product also softens the corners (Chromium drops a backdrop's mask under a clip path). Both are
 * drawn with the element, never loaded, so the first frame a capture takes already has them.
 */
function regionShape(region: Region, size: { width: number; height: number }) {
  const { width: W, height: H } = size;
  const x = region.box.x * W;
  const y = region.box.y * H;
  const w = region.box.width * W;
  const h = region.box.height * H;
  const outside = region.effect === "highlight" || region.area === "outside";
  const half = region.feather / 2;
  if (half) {
    // Soft from half the feather outside each edge to half inside it.
    const ramp = (from: number, to: number, direction: string) =>
      `linear-gradient(${direction},transparent ${px(from - half)},#000 ${px(from + half)},#000 ${px(to - half)},transparent ${px(to + half)})`;
    const box = `${ramp(y, y + h, "to bottom")},${ramp(x, x + w, "to right")}`;
    return outside
      ? `clip-path:none;mask-image:linear-gradient(#000,#000),${box};mask-composite:exclude,intersect`
      : `clip-path:none;mask-image:${box};mask-composite:intersect`;
  }
  return outside
    ? `clip-path:path(evenodd,"M0 0H${number(W)}V${number(H)}H0Z${roundedRect(x, y, w, h, region.radius)}");mask-image:none`
    : `clip-path:inset(${px(y)} ${px(W - x - w)} ${px(H - y - h)} ${px(x)} round ${px(region.radius)});mask-image:none`;
}

function backdrop(region: Region) {
  const filters = [
    ...(region.blur ? [`blur(${number(region.blur)}px)`] : []),
    ...(region.effect === "highlight" && region.dim
      ? [`brightness(${number(1 - region.dim)})`]
      : []),
  ];
  return filters.length ? filters.join(" ") : "none";
}

/** Whether a clip draws on screen at all. */
const shown = (clip: Clip, timeline: Pick<Timeline, "tracks">) =>
  clip.enabled &&
  !isAudioKind(clip.kind) &&
  timeline.tracks.find((track) => track.index === clip.track)?.enabled !==
    false;

/**
 * The stylesheet that draws every region on the timeline, or null when it has none. Every value
 * in it is a number from a validated region, an ease's curve, or an escaped clip id.
 */
export function regionStyle(
  timeline: Pick<Timeline, "clips" | "tracks" | "fps">,
  size: { width: number; height: number },
): { css: string; clips: string[] } | null {
  const { clips, fps } = timeline;
  const visible = clips.filter((clip) => shown(clip, timeline));
  const zooms = new Map<Clip, Segment[]>();
  const rules: string[] = [];
  const animated: Clip[] = [];
  for (const source of visible) {
    const { region } = source;
    if (!region) continue;
    if (region.effect !== "zoom") {
      if (!source.adjustment) continue;
      const fade =
        region.in || region.out
          ? keyframes(
              "cutroom-fade",
              piecewise(
                [{ start: 0, end: source.duration, region }],
                "0",
                () => "1",
              ),
              "opacity",
            )
          : null;
      if (fade) rules.push(fade.rule);
      rules.push(
        `${byId(source.id)}{backdrop-filter:${backdrop(region)};${regionShape(region, size)};mask-size:100% 100%;mask-repeat:no-repeat${fade ? `;--cutroom-fade:${fade.name};--cutroom-fade-duration:${seconds(fade.length, fps)}` : ""}}`,
      );
      animated.push(source);
      continue;
    }
    if (region.box.width >= 1) continue;
    const range = { start: source.start, end: source.start + source.duration };
    const targets = source.adjustment
      ? visible.filter((clip) => {
          const span = elementSpan(clip);
          return (
            clip.track < source.track &&
            span.start < range.end &&
            range.start < span.end
          );
        })
      : [source];
    for (const target of targets) {
      const span = elementSpan(target);
      zooms.set(target, [
        ...(zooms.get(target) ?? []),
        {
          start: range.start - span.start,
          end: range.end - span.start,
          region,
        },
      ]);
    }
  }
  for (const [target, segments] of zooms) {
    // One animation per picture, over all its zooms, delayed to the first: it may start before
    // the clip does, and its iterations stop at the clip's end, so it never lengthens the composition.
    const first = Math.min(...segments.map((segment) => segment.start));
    const zoom = keyframes(
      "cutroom-zoom",
      piecewise(
        segments.map((segment) => ({
          ...segment,
          start: segment.start - first,
          end: segment.end - first,
        })),
        "0px 0px 0px",
        (region) => zoomTranslate(region, size),
      ),
      "translate",
    );
    const span = elementSpan(target);
    const iterations = Math.min(
      1,
      Math.max(0, (span.end - span.start - first) / zoom.length),
    );
    rules.push(
      zoom.rule,
      `${byId(target.id)}{--cutroom-zoom:${zoom.name};--cutroom-zoom-duration:${seconds(zoom.length, fps)};--cutroom-zoom-delay:${seconds(first, fps)};--cutroom-zoom-iterations:${number(iterations)}}`,
    );
    animated.push(target);
  }
  if (!rules.length) return null;
  const ids = [...new Set(animated)].map((clip) => clip.id);
  const zoomed = [...zooms.keys()].map((clip) => byId(clip.id));
  const css = [
    `[${ADJUSTMENT_ATTRIBUTE}]{position:absolute;inset:0;pointer-events:none}`,
    ...(zoomed.length
      ? [
          `:has(> :is(${zoomed.join(",")})){perspective:${PERSPECTIVE}px;perspective-origin:50% 50%}`,
        ]
      : []),
    ...(animated.length
      ? [
          // A clip's keyframes run first, as their own stylesheet lists them.
          `:where(${ids.map(byId).join(",")}){` +
            `animation-name:${KEYFRAME_ANIMATION.name},${REGION_ANIMATION.name};` +
            `animation-duration:${KEYFRAME_ANIMATION.duration},${REGION_ANIMATION.duration};` +
            `animation-delay:${KEYFRAME_ANIMATION.delay},${REGION_ANIMATION.delay};` +
            `animation-iteration-count:${KEYFRAME_ANIMATION.iterations},${REGION_ANIMATION.iterations};` +
            `animation-fill-mode:${KEYFRAME_ANIMATION.fill},${REGION_ANIMATION.fill};` +
            `animation-timing-function:${KEYFRAME_ANIMATION.timing},${REGION_ANIMATION.timing};` +
            `animation-composition:replace,${REGION_ANIMATION.composition}}`,
        ]
      : []),
    ...rules,
  ].join("\n");
  return { css, clips: ids };
}
