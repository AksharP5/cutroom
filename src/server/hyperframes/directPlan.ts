import { offsetSourceTime } from "../../shared/timeline/time.ts";
import { transform, transformStyleAttribute } from "lightningcss";
import type { Declaration, Rule, SelectorComponent } from "lightningcss";
import { defaultTreeAdapter, parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { Fps } from "../../shared/timeline/schema.ts";
import { emptyTimelineSettings } from "../../shared/timeline/schema.ts";
import { GRADE_ATTRIBUTE, readGrade } from "../../shared/timeline/grade.ts";
import {
  REGION_ATTRIBUTE,
  REGION_STYLE_ATTRIBUTE,
  regionStyle,
} from "../../shared/timeline/regionStyle.ts";
import { parseComposition } from "../timeline/composition.ts";
import { readPosition } from "../timeline/position.ts";
import { readClipStyle } from "../timeline/style.ts";
import {
  TRANSITION_STYLE_ATTRIBUTE,
  transitionStyle,
} from "../timeline/transitions.ts";
import { coversFrame, visibleRect } from "./directPlacement.ts";
import type { DirectPlan, Placement, SourceSegment } from "./directSchema.ts";

type Frames = DirectPlan["frames"];
type Element = DefaultTreeAdapterTypes.Element;

/** Why the export needs the browser, for the logs; never shown as an error. */
type Refusal = { reason: string };

/** Cutroom's starter page loads GSAP, which does nothing until a script uses it. */
export const LIBRARY_SCRIPTS = new Set(["assets/vendor/gsap.min.js"]);

/**
 * Declarations that may reach the page, body or composition root. A full-frame opaque video
 * covers whatever these paint, so only layout that could move or resize the video is pinned.
 */
const FREE_PROPERTIES = new Set([
  "box-sizing",
  "color",
  "background",
  "background-color",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "z-index",
]);
export const declarationsOf = (css: string) => {
  const found: Declaration[] = [];
  transformStyleAttribute({
    code: Buffer.from(css),
    visitor: {
      Declaration(declaration) {
        found.push(declaration);
      },
    },
  });
  return found;
};
export const key = (declaration: Declaration) => JSON.stringify(declaration);
export const PINNED = new Set(
  declarationsOf(
    "margin:0;padding:0;width:100%;height:100%;overflow:hidden;position:relative;position:static",
  ).map(key),
);
/** The inline style Cutroom writes on a placed video, in any order. */
const VIDEO_REQUIRED = declarationsOf(
  "position:absolute;inset:0;width:100%;height:100%",
).map(key);
export const VIDEO_FITS = new Map(
  (["contain", "fill", "cover"] as const).map((fit) => [
    key(declarationsOf(`object-fit:${fit}`)[0]!),
    fit,
  ]),
);
/** The inline longhands Cutroom's inspector writes, which `readClipStyle` reads. */
const PLACEMENT_PROPERTIES = new Set([
  "opacity",
  "scale",
  "rotate",
  "clip-path",
]);

/** The Position offset, which the runtime draws as a `translate` of `data-x` less its baseline. */
const POSITION_ATTRIBUTES = [
  "data-x",
  "data-y",
  "data-hf-edit-base-x",
  "data-hf-edit-base-y",
];
/** Attributes a video clip may carry. Sound attributes are inert on a muted element. */
const VIDEO_ATTRIBUTES = new Set([
  "id",
  "src",
  "style",
  "muted",
  "data-start",
  "data-duration",
  "data-track-index",
  "data-media-start",
  "data-link",
  "data-label",
  "data-timeline-label",
  "data-has-audio",
  "data-volume",
  "data-fade-in",
  "data-fade-out",
  "data-cutroom-muted",
  "data-hf-id",
  ...POSITION_ATTRIBUTES,
]);
/** Attributes Cutroom writes on a placed image. */
const IMAGE_ATTRIBUTES = new Set([
  "id",
  "class",
  "src",
  "style",
  "data-start",
  "data-duration",
  "data-track-index",
  "data-label",
  "data-timeline-label",
  "data-hf-id",
  ...POSITION_ATTRIBUTES,
]);
export const ROOT_ATTRIBUTES = new Set([
  "id",
  "class",
  "data-composition-id",
  "data-no-timeline",
  "data-width",
  "data-height",
  "data-duration",
  "data-fps",
  "data-hf-id",
]);

/** Elements that run code, or bring in styles or another document, wherever they sit. */
const ACTIVE_ELEMENTS = new Set([
  "script",
  "style",
  "link",
  "iframe",
  "frame",
  "object",
  "embed",
]);

/**
 * Why something inside the composition could change what any frame shows, or undefined. A script
 * or event handler can rewrite any clip, a nested stylesheet can restyle one, and a frame or
 * plugin draws a document of its own, so none of them may hide inside a clip.
 */
export function activeContent(root: Element): string | undefined {
  const inside = (element: Element): string | undefined => {
    if (ACTIVE_ELEMENTS.has(element.tagName)) return `a <${element.tagName}>`;
    const handler = element.attrs.find((entry) => /^on/i.test(entry.name));
    if (handler) return `an ${handler.name} handler`;
    for (const child of elements(element)) {
      const found = inside(child);
      if (found) return found;
    }
    return undefined;
  };
  for (const clip of elements(root)) {
    const found = inside(clip);
    if (found)
      return `${attribute(clip, "id") ?? "the composition"} has ${found}`;
  }
  return undefined;
}

export const attribute = (element: Element, name: string) =>
  element.attrs.find((entry) => entry.name === name)?.value;
export const elements = (node: DefaultTreeAdapterTypes.ParentNode) =>
  node.childNodes.filter(defaultTreeAdapter.isElementNode);

/** Whether a selector's subject could be this element. Unknown parts count as a match. */
function mayMatch(selector: SelectorComponent[], element: Element) {
  const combinator = selector.findLastIndex(
    (component) => component.type === "combinator",
  );
  const subject = selector.slice(combinator + 1);
  const classes = new Set((attribute(element, "class") ?? "").split(/\s+/));
  return subject.every((component) => {
    switch (component.type) {
      case "type":
        return component.name === element.tagName;
      case "class":
        return classes.has(component.name);
      case "id":
        return component.name === attribute(element, "id");
      case "attribute":
        return attribute(element, component.name) !== undefined;
      default:
        return true;
    }
  });
}

/**
 * Stacking from Cutroom's track layer: z-index by `data-track-index`, unless anything else sets
 * one; and the background declarations that may reach the page, body or composition root.
 */
export type Stacking = {
  trackZ: Map<string, number>;
  authored: boolean;
  backgrounds: { element: Element; declaration: Declaration }[];
};

/** The one `data-track-index` value a track-layer rule selects, found inside its `:where()`. */
function trackOf(selectors: SelectorComponent[][]) {
  const found: string[] = [];
  const walk = (components: SelectorComponent[]) => {
    for (const component of components) {
      if (
        component.type === "attribute" &&
        component.name === "data-track-index" &&
        component.operation?.operator === "equal"
      )
        found.push(component.operation.value);
      if ("selectors" in component && Array.isArray(component.selectors))
        for (const nested of component.selectors)
          walk(Array.isArray(nested) ? nested : [nested]);
    }
  };
  if (selectors.length === 1) walk(selectors[0]!);
  return found.length === 1 ? found[0] : undefined;
}

export function checkStylesheet(
  css: string,
  protectedElements: { element: Element; clip: boolean }[],
  stacking: Stacking,
  pinned: ReadonlySet<string> = PINNED,
  managedAnimations = false,
): string | undefined {
  let refusal: string | undefined;
  const visit = (rules: Rule[], tracks: boolean) => {
    for (const rule of rules) {
      if (refusal) return;
      switch (rule.type) {
        case "media":
        case "supports":
          visit(rule.value.rules ?? [], tracks);
          continue;
        case "layer-block":
          visit(
            rule.value.rules,
            tracks || rule.value.name?.join(".") === "cutroom-tracks",
          );
          continue;
        case "layer-statement":
        case "font-face":
          continue;
        case "keyframes":
          if (
            managedAnimations &&
            /^cutroom-(zoom|fade|dissolve|dip)-/.test(rule.value.name.value)
          )
            refusal = "a stylesheet overrides a Cutroom animation";
          continue;
        case "style":
          break;
        default:
          refusal = `a stylesheet has an @${rule.type} rule`;
          return;
      }
      const { selectors } = rule.value;
      const declarations = rule.value.declarations?.declarations ?? [];
      if (rule.value.declarations?.importantDeclarations?.length) {
        refusal = "a stylesheet uses !important";
        return;
      }
      for (const declaration of declarations) {
        if (declaration.property !== "z-index") continue;
        const track = tracks ? trackOf(selectors) : undefined;
        if (track !== undefined && declaration.value.type === "integer")
          stacking.trackZ.set(track, declaration.value.value);
        else stacking.authored = true;
      }
      for (const { element, clip } of protectedElements) {
        const matching = selectors.filter((selector) =>
          mayMatch(selector, element),
        );
        if (!matching.length) continue;
        if (
          matching.some((selector) =>
            selector.some((component) => component.type === "pseudo-element"),
          )
        ) {
          refusal = `a stylesheet draws a pseudo-element on <${element.tagName}>`;
          return;
        }
        for (const declaration of declarations) {
          const allowed = clip
            ? declaration.property === "box-sizing" ||
              declaration.property === "z-index"
            : FREE_PROPERTIES.has(declaration.property) ||
              pinned.has(key(declaration));
          if (!allowed) {
            refusal = `a stylesheet sets ${declaration.property} on <${element.tagName}>`;
            return;
          }
          if (
            declaration.property === "background" ||
            declaration.property === "background-color"
          )
            stacking.backgrounds.push({ element, declaration });
        }
      }
      visit(rule.value.rules ?? [], tracks);
    }
  };
  transform({
    filename: "composition.css",
    code: Buffer.from(css),
    visitor: {
      StyleSheet(sheet) {
        visit(sheet.rules, false);
      },
    },
  });
  return refusal;
}

export const seconds = (value: string | undefined) => {
  if (value === undefined || !/^\s*\d+(\.\d+)?\s*$/.test(value)) return null;
  return Number(value);
};

const TRANSITION_ATTRIBUTE =
  /^data-transition-(in|out)(-duration|-align|-under)?$/;

/** Accept the generated region sheet only when its inputs still match the saved document. */
function regionFrames(
  html: string,
  css: string,
  root: Element,
  fps: Fps,
  width: number,
  height: number,
) {
  const ids = new Set<string>();
  const uniqueIds = (element: Element): boolean => {
    const id = attribute(element, "id");
    if (id && ids.has(id)) return false;
    if (id) ids.add(id);
    return elements(element).every(uniqueIds);
  };
  if (!uniqueIds(root)) return null;
  try {
    const { timeline } = parseComposition(html, emptyTimelineSettings());
    if (timeline.fps.num * fps.den !== fps.num * timeline.fps.den) return null;
    if (regionStyle(timeline, { width, height })?.css !== css) return null;
    return timeline.clips.flatMap(({ enabled, start, duration, region }) =>
      enabled && region ? [{ start, end: start + duration }] : [],
    );
  } catch {
    return null;
  }
}

/**
 * Plans an export that FFmpeg can draw from the sources without a browser: every frame shows one
 * video clip, full frame, with nothing over it. Anything this cannot prove the browser would draw
 * the same way returns a reason instead, and the export uses frame capture.
 */
export function planDirectExport(
  html: string,
  fps: Fps,
  range: Frames | null,
): DirectPlan | Refusal {
  const document = parse(html);
  const page = elements(document).find((element) => element.tagName === "html");
  const head =
    page && elements(page).find((element) => element.tagName === "head");
  const body =
    page && elements(page).find((element) => element.tagName === "body");
  if (!page || !head || !body)
    return { reason: "the page has no head or body" };
  const toFrame = (time: number) => (time * fps.num) / fps.den;
  /** A boundary the runtime draws from: within a thousandth of a frame counts as on it. */
  const frameAt = (time: number) => {
    const frame = toFrame(time);
    return Math.abs(frame - Math.round(frame)) < 1e-3
      ? Math.round(frame)
      : null;
  };

  const strayText = (node: DefaultTreeAdapterTypes.ParentNode) =>
    node.childNodes.some(
      (child) =>
        defaultTreeAdapter.isTextNode(child) && child.value.trim() !== "",
    );
  const roots = elements(body);
  const root = roots[0];
  if (
    roots.length !== 1 ||
    !root ||
    attribute(root, "data-composition-id") === undefined
  )
    return { reason: "the body holds more than the composition" };
  if (strayText(body) || strayText(root))
    return { reason: "the composition has text outside a clip" };
  const active = activeContent(root);
  if (active) return { reason: active };
  for (const element of [page, body])
    if (element.attrs.some((entry) => entry.name !== "lang"))
      return { reason: `<${element.tagName}> has attributes` };
  const unknownRootAttribute = root.attrs.find(
    (entry) => !ROOT_ATTRIBUTES.has(entry.name),
  );
  if (unknownRootAttribute)
    return { reason: `the composition has ${unknownRootAttribute.name}` };
  const width = Number(attribute(root, "data-width"));
  const height = Number(attribute(root, "data-height"));
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width % 2 ||
    height % 2
  )
    return { reason: "the composition size is not an even number of pixels" };

  const styles: string[] = [];
  let transitions = false;
  let regions = false;
  const effects: Frames[] = [];
  for (const element of elements(head)) {
    if (element.tagName === "meta" || element.tagName === "title") continue;
    if (element.tagName === "style") {
      const css = element.childNodes
        .filter(defaultTreeAdapter.isTextNode)
        .map((node) => node.value)
        .join("")
        .trim();
      const marker = element.attrs[0];
      if (element.attrs.length === 1 && marker) {
        if (
          marker.name === TRANSITION_STYLE_ATTRIBUTE &&
          `<style ${marker.name}="${marker.value}">\n${css}\n</style>` ===
            transitionStyle()
        ) {
          transitions = true;
          continue;
        }
        if (marker.name === REGION_STYLE_ATTRIBUTE && marker.value === "1") {
          const spans = regionFrames(html, css, root, fps, width, height);
          if (spans) {
            regions = true;
            effects.push(...spans);
            continue;
          }
        }
      }
      styles.push(css);
      continue;
    }
    if (
      element.tagName === "script" &&
      LIBRARY_SCRIPTS.has(attribute(element, "src") ?? "") &&
      element.childNodes.length === 0 &&
      element.attrs.length === 1
    )
      continue;
    return { reason: `the head has a <${element.tagName}>` };
  }

  type Clip = { element: Element; start: number; end: number };
  const visual: Clip[] = [];
  const pictures: Element[] = [];
  const stacking: Stacking = {
    trackZ: new Map(),
    authored: false,
    backgrounds: [],
  };
  let end = 0;
  for (const element of elements(root)) {
    if (element.tagName === "hf-audio-group" && element.childNodes.length === 0)
      continue;
    if (attribute(element, "data-hidden") !== undefined) continue;
    const start = seconds(attribute(element, "data-start"));
    const duration = seconds(attribute(element, "data-duration"));
    if (start === null || duration === null)
      return {
        reason: `${attribute(element, "id") ?? element.tagName} has no fixed start and duration`,
      };
    const first = frameAt(start);
    const last = frameAt(start + duration);
    if (first === null || last === null)
      return {
        reason: `${attribute(element, "id") ?? element.tagName} starts or ends between frames`,
      };
    end = Math.max(end, last);
    if (element.tagName === "audio") continue;
    if (element.tagName === "video" || element.tagName === "img")
      pictures.push(element);
    const layer = attribute(element, "data-cutroom-adjustment") !== undefined;
    const adjustment =
      layer && attribute(element, GRADE_ATTRIBUTE) !== undefined;
    if (
      layer &&
      !adjustment &&
      attribute(element, REGION_ATTRIBUTE) === undefined
    )
      continue;
    if (adjustment) effects.push({ start: first, end: last });
    visual.push({ element, start: first, end: last });
    if (transitions) {
      for (const edge of ["in", "out"] as const) {
        const kind = attribute(element, `data-transition-${edge}`);
        if (kind !== "dissolve" && kind !== "dip") continue;
        if (
          kind === "dissolve" &&
          attribute(element, `data-transition-${edge}-under`) !== undefined
        )
          continue;
        const length = seconds(
          attribute(element, `data-transition-${edge}-duration`),
        );
        // CSS starts the outgoing animation at the element's end minus its duration.
        // If the attribute is not on Cutroom's frame grid, let the browser draw this clip.
        const count = length === null ? null : frameAt(length);
        if (count === null || count > last - first)
          effects.push({ start: first, end: last });
        else if (count > 0)
          effects.push(
            edge === "in"
              ? { start: first, end: first + count }
              : { start: last - count, end: last },
          );
      }
    }
    try {
      if (
        declarationsOf(attribute(element, "style") ?? "").some(
          (declaration) => declaration.property === "z-index",
        )
      )
        stacking.authored = true;
    } catch {
      stacking.authored = true;
    }
  }
  for (const video of pictures)
    if (
      video.tagName === "video" &&
      attribute(video, "muted") === undefined &&
      attribute(video, "data-has-audio") !== "false"
    )
      return { reason: `${attribute(video, "id")} plays its own sound` };

  const declared = seconds(attribute(root, "data-duration"));
  if (declared === null)
    return { reason: "the composition has no fixed length" };
  const durationFrames =
    declared > 0 ? Math.ceil(toFrame(declared) - 1e-3) : end;
  const frames = range ?? { start: 0, end: durationFrames };
  if (frames.end > durationFrames || frames.start >= frames.end)
    return { reason: "the range is outside the composition" };

  const protectedElements = [
    { element: page, clip: false },
    { element: body, clip: false },
    { element: root, clip: false },
    ...pictures.map((element) => ({ element, clip: true })),
  ];
  for (const css of styles) {
    const refusal = checkStylesheet(
      css,
      protectedElements,
      stacking,
      PINNED,
      regions || transitions,
    );
    if (refusal) return { reason: refusal };
  }

  const colour = pageColour(stacking.backgrounds, { page, body });
  // Clips paint by their track layer's z-index, then in document order. Any other z-index
  // could reorder them, so frames with more than one clip then go to the browser.
  const level = (clip: Clip) =>
    stacking.trackZ.get(attribute(clip.element, "data-track-index") ?? "") ?? 0;
  const boundaries = [
    ...new Set([
      frames.start,
      frames.end,
      ...visual
        .flatMap((clip) => [clip.start, clip.end])
        .filter((at) => at > frames.start && at < frames.end),
      ...effects
        .flatMap(({ start, end }) => [start, end])
        .filter((at) => at > frames.start && at < frames.end),
    ]),
  ].sort((a, b) => a - b);
  const segments: DirectPlan["segments"] = [];
  let reason: string | undefined;
  for (const [index, start] of boundaries.slice(0, -1).entries()) {
    const end = boundaries[index + 1]!;
    const showing = visual.filter(
      (clip) => clip.start <= start && start < clip.end,
    );
    const top = showing.reduce<Clip | undefined>(
      (above, clip) => (above && level(above) > level(clip) ? above : clip),
      undefined,
    );
    const drawn = effects.some(
      (span) => span.start <= start && start < span.end,
    )
      ? { reason: `frame ${start} draws a Cutroom effect` }
      : !top
        ? { reason: `frame ${start} shows no clip` }
        : showing.length > 1 && stacking.authored
          ? {
              reason: `frame ${start} shows ${showing.length} clips in an authored order`,
            }
          : placedClip(
              {
                ...top.element,
                attrs: top.element.attrs.filter(
                  ({ name }) =>
                    !(regions && name === REGION_ATTRIBUTE) &&
                    !(transitions && TRANSITION_ATTRIBUTE.test(name)),
                ),
              },
              {
                width,
                height,
                beneath: showing.length === 1 ? colour : null,
              },
            );
    const previous = segments.at(-1);
    if ("reason" in drawn || !top) {
      reason ??= "reason" in drawn ? drawn.reason : undefined;
      if (previous?.kind === "capture") previous.end = end;
      else segments.push({ kind: "capture", start, end });
      continue;
    }
    const src = attribute(top.element, "src")!;
    const mediaStart = offsetSourceTime(
      seconds(attribute(top.element, "data-media-start") ?? "0")!,
      start - top.start,
      fps,
    );
    segments.push({ kind: "source", start, end, src, mediaStart, ...drawn });
  }
  if (!segments.some((segment) => segment.kind === "source"))
    return { reason: reason ?? "no frame shows a plain video" };
  return { width, height, durationFrames, frames, segments };
}

/** A `background` or `background-color` that paints one opaque colour, as `#rrggbb`. */
function solidColour(declaration: Declaration) {
  const colour =
    declaration.property === "background-color"
      ? declaration.value
      : declaration.property === "background" &&
          declaration.value.length === 1 &&
          declaration.value[0]!.image.type === "none"
        ? declaration.value[0]!.color
        : undefined;
  if (typeof colour !== "object" || colour.type !== "rgb" || colour.alpha !== 1)
    return null;
  return `#${[colour.r, colour.g, colour.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The colour the browser paints beneath every clip. Only known when the page or body sets one,
 * since the canvas takes it from them, and every background that may reach the page, body or
 * composition root is that same opaque colour.
 */
export function pageColour(
  found: Stacking["backgrounds"],
  { page, body }: { page: Element; body: Element },
) {
  if (!found.some(({ element }) => element === page || element === body))
    return null;
  const colours = new Set(
    found.map(({ declaration }) => solidColour(declaration)),
  );
  const [colour] = colours;
  return colours.size === 1 && colour ? colour : null;
}

/**
 * A video or image clip as Cutroom places it: a box filling the frame, plus the inspector's
 * Position, Scale, Rotation, whole-pixel Crop and Opacity. A video drawn as a plain copy carries
 * no placement. One that may leave the frame uncovered or show through needs a known page colour
 * beneath it. A still's coverage depends on its size, which the server reads before export.
 */
export function placedClip(
  element: Element,
  frame: { width: number; height: number; beneath: string | null },
): Pick<SourceSegment, "still" | "placement" | "grade"> | Refusal {
  const id = attribute(element, "id") ?? "a clip";
  const image = element.tagName === "img";
  if (element.tagName !== "video" && !image)
    return { reason: `${id} is not a video or image` };
  const allowed = image ? IMAGE_ATTRIBUTES : VIDEO_ATTRIBUTES;
  const extra = element.attrs.find(
    (entry) => !allowed.has(entry.name) && entry.name !== GRADE_ATTRIBUTE,
  );
  if (extra) return { reason: `${id} has ${extra.name}` };
  // FFmpeg draws the grade as a 3D LUT baked from the same stages the runtime's shader runs.
  const read = readGrade(attribute(element, GRADE_ATTRIBUTE));
  if ("restriction" in read)
    return { reason: `${id} has a grade Cutroom cannot bake` };
  const grade = read.grade ? { grade: read.grade } : {};
  if (image && attribute(element, "class") !== "clip")
    return { reason: `${id} has a class of its own` };
  if (elements(element).length) return { reason: `${id} has child elements` };
  const src = attribute(element, "src");
  // The worker checks the path against the project; remote and query URLs go to the browser.
  if (!src || /^[a-z][a-z0-9+.-]*:|^\/\/|[?#]/i.test(src))
    return { reason: `${id} is not a file in the project` };
  if (seconds(attribute(element, "data-media-start") ?? "0") === null)
    return { reason: `${id} has an unreadable media start` };
  let declarations: Declaration[];
  try {
    declarations = declarationsOf(attribute(element, "style") ?? "");
  } catch {
    return { reason: `${id} has an unreadable style` };
  }
  const keys = declarations.map(key);
  if (
    !VIDEO_REQUIRED.every((declaration) => keys.includes(declaration)) ||
    declarations.some(
      (declaration, index) =>
        !VIDEO_REQUIRED.includes(keys[index]!) &&
        !VIDEO_FITS.has(keys[index]!) &&
        !PLACEMENT_PROPERTIES.has(declaration.property),
    )
  )
    return { reason: `${id} is not placed in a box filling the frame` };
  const style = readClipStyle(attribute(element, "style"));
  if (style.restriction)
    return { reason: `${id} has a transform the inspector does not write` };
  if (
    style.opacity === null &&
    declarations.some((declaration) => declaration.property === "opacity")
  )
    return { reason: `${id} has an opacity Cutroom cannot read` };
  const attrs = Object.fromEntries(
    element.attrs.map((entry) => [entry.name, entry.value]),
  );
  const based = (axis: "x" | "y") =>
    attrs[`data-${axis}`] === undefined ||
    attrs[`data-hf-edit-base-${axis}`] !== undefined;
  if (!based("x") || !based("y"))
    return { reason: `${id} has a position without its baseline` };
  const crop = style.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  if (!Object.values(crop).every(Number.isInteger))
    return { reason: `${id} crops part of a pixel` };
  const placement: Placement = {
    x: readPosition(attrs, "x") ?? 0,
    y: readPosition(attrs, "y") ?? 0,
    scaleX: style.scaleX ?? 1,
    scaleY: style.scaleY ?? 1,
    rotation: style.rotation ?? 0,
    crop,
    opacity: style.opacity ?? 1,
    beneath: frame.beneath,
  };
  const fit =
    declarations
      .map((_, index) => VIDEO_FITS.get(keys[index]!))
      .findLast((value) => value !== undefined) ?? "fill";
  if (image) return { still: { fit }, placement, ...grade };
  const plain =
    placement.x === 0 &&
    placement.y === 0 &&
    placement.scaleX === 1 &&
    placement.scaleY === 1 &&
    placement.rotation === 0 &&
    Object.values(crop).every((edge) => edge === 0) &&
    placement.opacity === 1;
  if (plain) return grade;
  // The worker refuses a video whose shape differs from the frame's, so its picture fills the box.
  const box = { left: 0, top: 0, right: frame.width, bottom: frame.height };
  const shown = visibleRect(box, crop, frame);
  if (!shown) return { reason: `${id} is cropped away` };
  if (!frame.beneath && !coversFrame(placement, shown, frame))
    return { reason: `${id} shows what lies beneath it` };
  return { placement, ...grade };
}
