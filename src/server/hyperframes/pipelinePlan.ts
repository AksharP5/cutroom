import { transform } from "lightningcss";
import type { Declaration } from "lightningcss";
import { defaultTreeAdapter, parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { Fps } from "../../shared/timeline/schema.ts";
import type { PipelinePlan } from "../../shared/pipeline.ts";
import { readClipStyle } from "../timeline/style.ts";
import {
  TRANSITION_STYLE_ATTRIBUTE,
  readTransitions,
  transitionStyle,
} from "../timeline/transitions.ts";
import {
  LIBRARY_SCRIPTS,
  activeContent,
  PINNED,
  ROOT_ATTRIBUTES,
  VIDEO_FITS,
  attribute,
  checkStylesheet,
  declarationsOf,
  elements,
  key,
  pageColour,
  placedClip,
  seconds,
} from "./directPlan.ts";
import type { Stacking } from "./directPlan.ts";

type Element = DefaultTreeAdapterTypes.Element;

/** The one transitions stylesheet Cutroom writes, which the pipeline draws itself. */
const TRANSITION_RULES = /<style[^>]*>([\s\S]*)<\/style>/
  .exec(transitionStyle())![1]!
  .trim();
const TRANSITION_ATTRIBUTE =
  /^data-transition-(in|out)(-duration|-align|-under)?$/;
/**
 * Effects that blend with whatever lies beneath. Beneath a HyperFrames layer is the pipeline's
 * canvas, which the preview document cannot see, so these must keep their initial values.
 */
const BACKDROP = new Set(["mix-blend-mode", "backdrop-filter"]);
const UNBLENDED = new Set(
  declarationsOf("mix-blend-mode:normal;backdrop-filter:none").map(key),
);
const blends = (declaration: Declaration) => {
  const name =
    declaration.property === "unparsed"
      ? declaration.value.propertyId.property
      : declaration.property === "custom"
        ? declaration.value.name
        : declaration.property;
  return BACKDROP.has(name) && !UNBLENDED.has(key(declaration)) ? name : null;
};
function blendInStylesheet(css: string) {
  let found: string | null = null;
  transform({
    filename: "composition.css",
    code: Buffer.from(css),
    visitor: {
      Declaration(declaration) {
        found ??= blends(declaration);
      },
    },
  });
  return found;
}
/** The first element under `node`, itself included, whose inline style blends. */
function blendInline(node: Element): string | null {
  try {
    const found = declarationsOf(attribute(node, "style") ?? "")
      .map(blends)
      .find(Boolean);
    if (found) return `${attribute(node, "id") ?? node.tagName} sets ${found}`;
  } catch {
    return `${attribute(node, "id") ?? node.tagName} has an unreadable style`;
  }
  for (const child of elements(node)) {
    const found = blendInline(child);
    if (found) return found;
  }
  return null;
}

const text = (element: Element) =>
  element.childNodes
    .filter(defaultTreeAdapter.isTextNode)
    .map((node) => node.value)
    .join("");

/**
 * Plans the viewer's footage pipeline with the export classifier's rules: a video clip is
 * drawable when the export could draw it from its source, and the pipeline paints beneath the
 * preview, so every clip HyperFrames draws must lie above every drawable video it overlaps.
 * Anything the rules cannot prove keeps the whole composition on HyperFrames, with a reason.
 */
export function planPreviewPipeline(html: string, fps: Fps): PipelinePlan {
  const document = parse(html);
  const page = elements(document).find((element) => element.tagName === "html");
  const head =
    page && elements(page).find((element) => element.tagName === "head");
  const body =
    page && elements(page).find((element) => element.tagName === "body");
  if (!page || !head || !body)
    return { reason: "the page has no head or body" };
  const roots = elements(body);
  const root = roots[0];
  if (
    roots.length !== 1 ||
    !root ||
    attribute(root, "data-composition-id") === undefined
  )
    return { reason: "the body holds more than the composition" };
  for (const element of [page, body])
    if (element.attrs.some((entry) => entry.name !== "lang"))
      return { reason: `<${element.tagName}> has attributes` };
  // A script, stylesheet, frame or event handler anywhere could change any clip.
  const active = activeContent(root);
  if (active) return { reason: active };
  const blended = blendInline(page);
  if (blended) return { reason: blended };
  const unknown = root.attrs.find((entry) => !ROOT_ATTRIBUTES.has(entry.name));
  if (unknown) return { reason: `the composition has ${unknown.name}` };
  const width = Number(attribute(root, "data-width"));
  const height = Number(attribute(root, "data-height"));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0)
    return { reason: "the composition has no size" };

  const styles: string[] = [];
  let transitionSheet = false;
  for (const element of elements(head)) {
    if (element.tagName === "meta" || element.tagName === "title") continue;
    if (element.tagName === "style") {
      // Cutroom's transitions sheet animates opacity and brightness, which the pipeline draws.
      if (
        attribute(element, TRANSITION_STYLE_ATTRIBUTE) !== undefined &&
        text(element).trim() === TRANSITION_RULES
      ) {
        transitionSheet = true;
        continue;
      }
      styles.push(text(element));
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

  const toFrame = (time: number) => (time * fps.num) / fps.den;
  const frameAt = (time: number) => {
    const frame = toFrame(time);
    return Math.abs(frame - Math.round(frame)) < 1e-3
      ? Math.round(frame)
      : null;
  };
  type Layer = {
    id: string;
    element: Element;
    start: number;
    end: number;
    track: string;
    index: number;
  };
  const videos: Layer[] = [];
  const others: Layer[] = [];
  const order: string[] = [];
  /** Videos HyperFrames draws, on top of the pipeline's, and why. */
  const hyperframes: Record<string, string> = {};
  for (const element of elements(root)) {
    if (element.tagName === "hf-audio-group" && element.childNodes.length === 0)
      continue;
    if (
      attribute(element, "data-hidden") !== undefined ||
      element.tagName === "audio"
    )
      continue;
    const start = seconds(attribute(element, "data-start"));
    const duration = seconds(attribute(element, "data-duration"));
    const id = attribute(element, "id") ?? attribute(element, "data-hf-id");
    if (start === null || duration === null || !id)
      return {
        reason: `${id ?? element.tagName} has no fixed start, duration and id`,
      };
    // HyperFrames draws everything but videos, so only a video must start and end on frames.
    const video = element.tagName === "video";
    const first = frameAt(start) ?? Math.floor(toFrame(start));
    const last =
      frameAt(start + duration) ?? Math.ceil(toFrame(start + duration));
    if (
      video &&
      (frameAt(start) === null || frameAt(start + duration) === null)
    )
      hyperframes[id] = `${id} starts or ends between frames`;
    const layer = {
      id,
      element,
      start: first,
      end: last,
      track: attribute(element, "data-track-index") ?? "",
      index: order.length,
    };
    order.push(id);
    (video ? videos : others).push(layer);
  }

  // A video the pipeline cannot draw exactly is HyperFrames', as a title is.
  const fits: Record<string, "fill" | "contain" | "cover"> = {};
  for (const { id, element } of videos) {
    if (hyperframes[id]) continue;
    if (
      attribute(element, "muted") === undefined &&
      attribute(element, "data-has-audio") !== "false"
    ) {
      hyperframes[id] = `${id} plays its own sound`;
      continue;
    }
    // The pipeline draws Cutroom's transitions; the rest of the clip must pass the export's rules.
    const edges = readTransitions(
      Object.fromEntries(
        element.attrs.map((entry) => [entry.name, entry.value]),
      ),
      fps,
    );
    const transitions = element.attrs.filter((entry) =>
      TRANSITION_ATTRIBUTE.test(entry.name),
    );
    if (
      transitions.length &&
      (!transitionSheet ||
        (!edges.in && !edges.out) ||
        (readClipStyle(attribute(element, "style")).opacity ?? 1) !== 1)
    ) {
      hyperframes[id] = `${id} has a transition the pipeline cannot draw`;
      continue;
    }
    const placed = placedClip(
      {
        ...element,
        attrs: element.attrs.filter(
          (entry) => !TRANSITION_ATTRIBUTE.test(entry.name),
        ),
      },
      // The pipeline draws whatever lies beneath, so coverage never matters here.
      { width, height, beneath: "#000000" },
    );
    if ("reason" in placed) {
      hyperframes[id] = placed.reason;
      continue;
    }
    if (placed.grade) {
      hyperframes[id] = `${id} is graded, which HyperFrames draws`;
      continue;
    }
    fits[id] =
      declarationsOf(attribute(element, "style") ?? "")
        .map((declaration) => VIDEO_FITS.get(key(declaration)))
        .findLast((fit) => fit !== undefined) ?? "fill";
  }

  const stacking: Stacking = {
    trackZ: new Map(),
    authored: false,
    backgrounds: [],
  };
  for (const { element } of [...videos, ...others])
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
  // The root may also name its own size in pixels, which is the same box.
  const pinned = new Set([
    ...PINNED,
    ...declarationsOf(`width:${width}px;height:${height}px`).map(key),
  ]);
  const protectedElements = [
    { element: page, clip: false },
    { element: body, clip: false },
    { element: root, clip: false },
    ...videos.map(({ element }) => ({ element, clip: true })),
  ];
  for (const css of styles) {
    const blend = blendInStylesheet(css);
    if (blend) return { reason: `a stylesheet sets ${blend}` };
    const refusal = checkStylesheet(css, protectedElements, stacking, pinned);
    if (refusal) return { reason: refusal };
  }
  if (stacking.authored)
    return { reason: "a stylesheet or clip sets its own z-index" };
  const background = pageColour(stacking.backgrounds, { page, body });
  if (background === null && stacking.backgrounds.length)
    return { reason: "the page background is not one colour" };

  const level = (layer: Layer) => stacking.trackZ.get(layer.track) ?? 0;
  const below = (a: Layer, b: Layer) =>
    level(a) < level(b) || (level(a) === level(b) && a.index < b.index);
  // The pipeline paints beneath the preview, so a video above anything HyperFrames draws at the
  // same time is HyperFrames' too, which may put more videos above one of its own.
  for (let settled = false; !settled;) {
    settled = true;
    const drawnByHyperframes = [
      ...others,
      ...videos.filter(({ id }) => hyperframes[id]),
    ];
    for (const video of videos) {
      if (hyperframes[video.id]) continue;
      const beneath = drawnByHyperframes.find(
        (other) =>
          other.start < video.end &&
          video.start < other.end &&
          !below(video, other),
      );
      if (!beneath) continue;
      hyperframes[video.id] = `${beneath.id} lies beneath ${video.id}`;
      delete fits[video.id];
      settled = false;
    }
  }
  if (!Object.keys(fits).length)
    return {
      reason: Object.values(hyperframes)[0] ?? "it has no video to draw",
    };

  return {
    width,
    height,
    drawable: fits,
    hyperframes,
    order,
    trackZ: Object.fromEntries(stacking.trackZ),
    background,
  };
}
