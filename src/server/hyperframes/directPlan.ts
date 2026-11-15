import { transform, transformStyleAttribute } from "lightningcss";
import type { Declaration, Rule, SelectorComponent } from "lightningcss";
import { defaultTreeAdapter, parse } from "parse5";
import { z } from "zod";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { Fps } from "../../shared/timeline/schema.ts";
import { ExportRangeSchema } from "../../shared/export.ts";

type Frames = z.infer<typeof ExportRangeSchema>;
type Element = DefaultTreeAdapterTypes.Element;

const frame = z.number().int().nonnegative();
/** A run of frames whose picture is one video clip, full frame, with nothing over it. */
const SourceSegmentSchema = z.object({
  kind: z.literal("source"),
  start: frame,
  end: frame,
  /** Project-relative source path, as the clip's `src` names it. */
  src: z.string().min(1),
  /** Source seconds shown on the segment's first frame. */
  mediaStart: z.number().nonnegative(),
});
/** A run of frames the browser draws. */
const CaptureSegmentSchema = z.object({
  kind: z.literal("capture"),
  start: frame,
  end: frame,
});
export const DirectPlanSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Frames in the whole composition, which the audio mix needs even for a range. */
  durationFrames: z.number().int().positive(),
  frames: ExportRangeSchema,
  /** In frame order, covering the range. At least one draws from a source. */
  segments: z
    .array(
      z.discriminatedUnion("kind", [SourceSegmentSchema, CaptureSegmentSchema]),
    )
    .min(1),
});
export type SourceSegment = z.infer<typeof SourceSegmentSchema>;
export type DirectPlan = z.infer<typeof DirectPlanSchema>;

/** Why the export needs the browser, for the logs; never shown as an error. */
type Refusal = { reason: string };

/**
 * Each captured run starts its own capture browsers, and a start can stall (HyperFrames gives a
 * stuck page minutes). Beyond this many runs, capturing the whole export starts browsers once.
 */
const MAX_CAPTURE_RUNS = 3;

/** Cutroom's starter page loads GSAP, which does nothing until a script uses it. */
const LIBRARY_SCRIPTS = new Set(["assets/vendor/gsap.min.js"]);

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
const declarationsOf = (css: string) => {
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
const key = (declaration: Declaration) => JSON.stringify(declaration);
const PINNED = new Set(
  declarationsOf(
    "margin:0;padding:0;width:100%;height:100%;overflow:hidden;position:relative;position:static",
  ).map(key),
);
/** The inline style Cutroom writes on a placed video, in any order. */
const VIDEO_REQUIRED = declarationsOf(
  "position:absolute;inset:0;width:100%;height:100%",
).map(key);
const VIDEO_FITS = new Map(
  (["contain", "fill", "cover"] as const).map((fit) => [
    key(declarationsOf(`object-fit:${fit}`)[0]!),
    fit,
  ]),
);
const VIDEO_OPTIONAL = new Set(declarationsOf("opacity:1").map(key));

/** Attributes a plain video clip may carry. Sound attributes are inert on a muted element. */
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
]);
const ROOT_ATTRIBUTES = new Set([
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

const attribute = (element: Element, name: string) =>
  element.attrs.find((entry) => entry.name === name)?.value;
const elements = (node: DefaultTreeAdapterTypes.ParentNode) =>
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

/** Stacking from Cutroom's track layer: z-index by `data-track-index`, unless anything else sets one. */
type Stacking = { trackZ: Map<string, number>; authored: boolean };

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

function checkStylesheet(
  css: string,
  protectedElements: { element: Element; video: boolean }[],
  stacking: Stacking,
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
        case "keyframes":
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
      for (const { element, video } of protectedElements) {
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
          const allowed = video
            ? declaration.property === "box-sizing" ||
              declaration.property === "z-index"
            : FREE_PROPERTIES.has(declaration.property) ||
              PINNED.has(key(declaration));
          if (!allowed) {
            refusal = `a stylesheet sets ${declaration.property} on <${element.tagName}>`;
            return;
          }
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

const seconds = (value: string | undefined) => {
  if (value === undefined || !/^\s*\d+(\.\d+)?\s*$/.test(value)) return null;
  return Number(value);
};

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
  for (const element of elements(head)) {
    if (element.tagName === "meta" || element.tagName === "title") continue;
    if (element.tagName === "style") {
      styles.push(
        element.childNodes
          .filter(defaultTreeAdapter.isTextNode)
          .map((node) => node.value)
          .join(""),
      );
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
  const videos: Element[] = [];
  const stacking: Stacking = { trackZ: new Map(), authored: false };
  let end = 0;
  for (const element of elements(root)) {
    if (element.tagName === "hf-audio-group" && element.childNodes.length === 0)
      continue;
    if (element.tagName === "script" || element.tagName === "style")
      return { reason: `the composition has a <${element.tagName}>` };
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
    if (element.tagName === "video") videos.push(element);
    visual.push({ element, start: first, end: last });
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
  for (const video of videos)
    if (
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
    { element: page, video: false },
    { element: body, video: false },
    { element: root, video: false },
    ...videos.map((element) => ({ element, video: true })),
  ];
  for (const css of styles) {
    const refusal = checkStylesheet(css, protectedElements, stacking);
    if (refusal) return { reason: refusal };
  }

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
    const refusal = !top
      ? `frame ${start} shows no clip`
      : showing.length > 1 && stacking.authored
        ? `frame ${start} shows ${showing.length} clips in an authored order`
        : plainVideo(top.element);
    const previous = segments.at(-1);
    if (refusal || !top) {
      reason ??= refusal;
      if (previous?.kind === "capture") previous.end = end;
      else segments.push({ kind: "capture", start, end });
      continue;
    }
    const src = attribute(top.element, "src")!;
    const mediaStart =
      seconds(attribute(top.element, "data-media-start") ?? "0")! +
      ((start - top.start) * fps.den) / fps.num;
    segments.push({ kind: "source", start, end, src, mediaStart });
  }
  if (!segments.some((segment) => segment.kind === "source"))
    return { reason: reason ?? "no frame shows a plain video" };
  const runs = segments.filter((segment) => segment.kind === "capture").length;
  if (runs > MAX_CAPTURE_RUNS)
    return {
      reason: `${runs} runs of frames need the browser, first ${reason}`,
    };
  return { width, height, durationFrames, frames, segments };
}

/** A video clip drawn as Cutroom places it: full frame, untransformed, opaque, at normal speed. */
function plainVideo(element: Element): string | undefined {
  const id = attribute(element, "id") ?? "a clip";
  if (element.tagName !== "video") return `${id} is not a video`;
  const extra = element.attrs.find(
    (entry) => !VIDEO_ATTRIBUTES.has(entry.name),
  );
  if (extra) return `${id} has ${extra.name}`;
  if (elements(element).length) return `${id} has child elements`;
  const src = attribute(element, "src");
  // The worker checks the path against the project; remote and query URLs go to the browser.
  if (!src || /^[a-z][a-z0-9+.-]*:|^\/\/|[?#]/i.test(src))
    return `${id} is not a file in the project`;
  if (seconds(attribute(element, "data-media-start") ?? "0") === null)
    return `${id} has an unreadable media start`;
  let declarations: string[];
  try {
    declarations = declarationsOf(attribute(element, "style") ?? "").map(key);
  } catch {
    return `${id} has an unreadable style`;
  }
  const remaining = declarations.filter(
    (declaration) =>
      !VIDEO_REQUIRED.includes(declaration) &&
      !VIDEO_FITS.has(declaration) &&
      !VIDEO_OPTIONAL.has(declaration),
  );
  if (
    remaining.length ||
    !VIDEO_REQUIRED.every((declaration) => declarations.includes(declaration))
  )
    return `${id} is not placed full frame`;
}
