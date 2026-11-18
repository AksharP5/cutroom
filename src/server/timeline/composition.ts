import {
  parseAutomation,
  serializeAutomation,
} from "@hyperframes/core/audio-automation";
import { isCompositionVariable } from "@hyperframes/core/variables";
import {
  CSS_URL_RE,
  rewriteSrcsetUrls,
} from "@hyperframes/parsers/asset-paths";
import { localMediaPath } from "../../shared/media";
import {
  parseSceneVariableValues,
  VariableError,
} from "../../shared/variables";
import type {
  CompositionVariable,
  VariableBinding,
  VariableValue,
} from "../../shared/variables";
import { freezeExportSource } from "../hyperframes/freezeSources";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";
import { readFadeSeconds } from "@hyperframes/core/audio-fade";
import {
  framesAfter,
  framesBefore,
  takesTransition,
} from "../../shared/timeline/transition";
import {
  elementClip,
  isCrossfadeAutomation,
  readTransitions,
  TRANSITION_STYLE_ATTRIBUTE,
  transitionAttributes,
  transitionStyle,
} from "./transitions";
import {
  canonicalText,
  firstTextLine,
  isAudioKind,
} from "../../shared/timeline/schema";
import { parseFpsWithDefault } from "@hyperframes/core";
import {
  clipStyle,
  readClipStyle,
  readColourVariable,
  readElementStyle,
  writeClipStyle,
} from "./style";
import { readPosition, positionAttributes } from "./position";
import {
  KEYFRAMES_ATTRIBUTE,
  KEYFRAME_STYLE_ATTRIBUTE,
  keyframeStyle,
  keyframesAttribute,
  readKeyframes,
} from "./keyframes";
import { shiftKeyframes } from "../../shared/timeline/keyframes";
import { sameRegion } from "../../shared/timeline/region";
import {
  ADJUSTMENT_ATTRIBUTE,
  REGION_ATTRIBUTE,
  REGION_STYLE_ATTRIBUTE,
  regionStyle,
} from "../../shared/timeline/regionStyle";
import { readRegion, regionAttribute } from "./regions";
import {
  CUTROOM_AUDIO_GROUP_PREFIX,
  offsetAutomation,
  trackGainWarning,
} from "../../shared/timeline/mix";
import { readFxChain, writeFxChain } from "../../shared/timeline/fx";
import {
  readVersions,
  rebaseVersions,
  versionAttributes,
  versionChanges,
  VERSIONS_ATTRIBUTE,
} from "./versions";
import {
  GRADE_ATTRIBUTE,
  readGrade,
  writeGrade,
} from "../../shared/timeline/grade";
import { posix } from "node:path";
import {
  DEFAULT_IMAGE_TIMELINE_DURATION_SECONDS,
  isSubCompositionHost,
  isTimedElement,
  parseNumeric,
  readClipTiming,
  readMediaOffsetSeconds,
  readPlaybackRate,
  resolveMediaDuration,
  scanHtmlOpeningTags,
  topLevelElements,
} from "@hyperframes/parsers";
import type { ClipTiming, HtmlOpeningTagSpan } from "@hyperframes/parsers";
import { defaultTreeAdapter, parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import {
  TimelineError,
  canonicalSeconds,
  clipEnd,
  frameTime,
  normalizeTimeline,
  toFrames,
  toSeconds,
} from "../../shared/timeline/apply";
import type { ClipOrigin } from "../../shared/timeline/apply";
import { trackMix } from "../../shared/timeline/tracks";
import type { TrackMix } from "../../shared/timeline/tracks";
import {
  declaredFonts,
  readTitle,
  titleAttributes,
  titleStyle,
} from "./titles";
import type {
  Clip,
  ClipKind,
  Fps,
  InsertClip,
  Timeline,
  TimelineSettings,
} from "../../shared/timeline/schema";

/** One element of the source, located by byte offsets so edits can leave everything else untouched. */
interface SourceRange {
  start: number;
  end: number;
  /** The bytes the node itself writes: an element's start and end tags, or a text node's text. */
  own: [number, number][];
}

interface OwnedBytes {
  start: number;
  end: number;
  /** The owning node's index in `nodes`. */
  node: number;
  /** The largest `end` among this range and every range sorted before it. */
  reach: number;
}

interface SourceElement {
  tag: string;
  attrs: Record<string, string>;
  insidePicture?: true;
  children: SourceElement[];
  text: string;
  /** A `<template>`'s inert content, outside the live tree. */
  content: SourceElement[];
  start: number;
  openEnd: number;
  end: number;
  /** Its position among the located nodes, in tree order. */
  index: number;
  /** Elements and text nodes the spec tree places inside it. */
  inner: number;
  /** The spec tree's child nodes, read only when a clip's words are projected. */
  nodes: DefaultTreeAdapterTypes.ChildNode[];
}

export interface ParsedComposition {
  html: string;
  timeline: Timeline;
  roots: SourceElement[];
  scope: CompositionScope;
  root: SourceElement;
  rootDurationAuthored: boolean;
  elements: Map<string, SourceElement>;
  /** Clips without an id attribute, which carry a positional stand-in id. */
  anonymous: Set<string>;
  ids: Set<string>;
  scripts: string[];
  scriptsAndStyles: string[];
  fonts: ReadonlySet<string>;
  /** Source line breaks stay visible when CSS might preserve them; uncertain cascades refuse edits. */
  textLayout: Map<SourceElement, { preserveLines: boolean; reason?: string }>;
  /** Source range of every element (start tag through end tag) and text node, in tree order. */
  nodes: SourceRange[];
  /**
   * Every node's own bytes, sorted by start. Ranges can overlap: text the parser fosters out of a
   * table merges into the text before it, so that text node's range spans the table's tags.
   */
  owned: OwnedBytes[];
}

/**
 * The HTML spec tree (parse5) with source offsets. Elements the parser implied, such as a missing
 * `<body>`, have no source and their children take their place.
 */
function parseElements(html: string) {
  const nodes: SourceRange[] = [];
  const visit = (children: DefaultTreeAdapterTypes.ChildNode[]) => {
    const elements: SourceElement[] = [];
    let text = "";
    for (const node of children) {
      if (defaultTreeAdapter.isTextNode(node)) {
        text += node.value;
        const location = node.sourceCodeLocation;
        if (location)
          nodes.push({
            start: location.startOffset,
            end: location.endOffset,
            own: [[location.startOffset, location.endOffset]],
          });
        continue;
      }
      if (!defaultTreeAdapter.isElementNode(node)) continue;
      const location = node.sourceCodeLocation;
      if (!location?.startTag) {
        const implied = visit(node.childNodes);
        elements.push(...implied.elements);
        text += implied.text;
        continue;
      }
      const index = nodes.length;
      const { startTag, endTag } = location;
      nodes.push({
        start: location.startOffset,
        end: location.endOffset,
        own: [
          [startTag.startOffset, startTag.endOffset],
          ...(endTag
            ? [[endTag.startOffset, endTag.endOffset] as [number, number]]
            : []),
        ],
      });
      const inert = "content" in node;
      const inside = visit(inert ? node.content.childNodes : node.childNodes);
      const contentText =
        inert || node.tagName === "script" || node.tagName === "style"
          ? ""
          : node.tagName === "br"
            ? "\n"
            : inside.text;
      text += /^(?:div|p|h[1-6]|li|section|article)$/.test(node.tagName)
        ? `\n${contentText}\n`
        : contentText;
      elements.push({
        text: contentText,
        tag: node.tagName,
        ...(node.tagName === "img" &&
          node.parentNode?.nodeName === "picture" && { insidePicture: true }),
        attrs: Object.fromEntries(
          node.attrs.map((attribute) => [attribute.name, attribute.value]),
        ),
        children: inert ? [] : inside.elements,
        content: inert ? inside.elements : [],
        start: location.startOffset,
        openEnd: location.startTag.endOffset,
        end: location.endOffset,
        index,
        inner: nodes.length - index - 1,
        nodes: inert ? [] : node.childNodes,
      });
    }
    return { elements, text };
  };
  const { elements: roots } = visit(
    parse(html, { sourceCodeLocationInfo: true }).childNodes,
  );
  let reach = 0;
  const owned = nodes
    .flatMap((node, index) =>
      node.own.map(([start, end]) => ({ start, end, node: index })),
    )
    .sort((a, b) => a.start - b.start)
    .map((range) => {
      reach = Math.max(reach, range.end);
      return { ...range, reach };
    });
  return { roots, nodes, owned };
}

function* descendants(
  elements: SourceElement[],
  includeTemplates = false,
): Generator<SourceElement> {
  for (const element of elements) {
    yield element;
    yield* descendants(element.children, includeTemplates);
    if (includeTemplates) yield* descendants(element.content, true);
  }
}

function clipKind(element: SourceElement): ClipKind {
  if (element.tag === "audio")
    return element.attrs["data-cutroom-kind"] === "voiceover"
      ? "voiceover"
      : "audio";
  if (element.tag === "video") return "video";
  if (element.tag === "img") return "image";
  return isSubCompositionHost(element) ? "composition" : "element";
}

function hasVideoAudio({ tag, attrs }: SourceElement) {
  return (
    tag === "video" &&
    (attrs.muted === undefined || attrs["data-cutroom-muted"] !== undefined) &&
    (attrs["data-has-audio"] ?? "true") === "true"
  );
}

/** A title must have both valid settings and words that can be edited as plain text. */
function readElementTitle(
  element: SourceElement,
  fps: Fps,
  fonts: ReadonlySet<string>,
) {
  const read = readTitle(element.attrs, fps, fonts);
  if (read && "title" in read && !elementText(element)?.plain)
    return {
      reason:
        "This title must contain non-empty plain text. Edit it in the source.",
    };
  return read;
}

const HTML_SPACE = /[\t\n\f\r ]+/g;

/**
 * A text element's words, with `<br>` as a line break. `plain` is false when anything else is
 * inside, such as a `<span>` or a comment, which a text edit would delete.
 */
function elementText(element: SourceElement, preserveLines = false) {
  if (
    element.tag === "svg" ||
    element.tag === "canvas" ||
    element.tag === "iframe"
  )
    return null;
  let plain = true;
  let text = "";
  const visit = (nodes: DefaultTreeAdapterTypes.ChildNode[]) => {
    for (const node of nodes) {
      if (defaultTreeAdapter.isTextNode(node))
        text += node.value.replace(
          preserveLines ? /[\t\f ]+/g : HTML_SPACE,
          " ",
        );
      else if (!defaultTreeAdapter.isElementNode(node)) plain = false;
      else if (node.tagName === "br") text += "\n";
      else {
        plain = false;
        if (["script", "style", "template"].includes(node.tagName)) continue;
        // Shown, never written: neighbouring elements read as separate words.
        text += " ";
        visit(node.childNodes);
        text += " ";
      }
    }
  };
  visit(element.nodes);
  text = canonicalText(text);
  return text ? { text, plain } : null;
}

/**
 * Whether a script writes this element's words: by id in the same statement, through a variable
 * it was read into, or as a GSAP text tween. Scripts that reach it another way are not detected,
 * and a text edit there changes the source the script then overwrites.
 */
function scriptWritesText(scripts: readonly string[], id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reference = `(?:#${escaped}(?![\\w-])|["'\`]${escaped}["'\`])`;
  const write =
    "(?:textContent|innerText|innerHTML|outerHTML|replaceChildren|insertAdjacentHTML|insertAdjacentText)\\b";
  const direct = new RegExp(`${reference}[^;{}]{0,120}\\.${write}`);
  const tween = new RegExp(
    `${reference}["'\`]?\\s*,\\s*\\{[^}]{0,400}\\b(?:text|scrambleText)\\s*:`,
  );
  const held = new RegExp(
    `(?:const|let|var)\\s+([\\w$]+)\\s*=[^;\\n]{0,160}${reference}`,
    "g",
  );
  return scripts.some(
    (script) =>
      direct.test(script) ||
      tween.test(script) ||
      [...script.matchAll(held)].some(([, name]) =>
        new RegExp(
          `(?<![\\w$.])${name!.replaceAll("$", "\\$")}\\.${write}`,
        ).test(script),
      ),
  );
}

/**
 * The source time at a clip's first shown frame. An authored start between frames shifts it by the
 * gap to that frame; a start the editor wrote, within a microsecond of the frame, does not, so the
 * offset never depends on how the start was rounded. A start a hair past a frame shows from that
 * frame, before the source begins, and a media element seeks a negative time to 0.
 */
function sourceAtFirstFrame(
  authored: number,
  untilFirstFrame: number,
  playbackRate: number,
): number {
  const shift = Math.abs(untilFirstFrame) <= 1e-6 ? 0 : untilFirstFrame;
  return Math.max(0, canonicalSeconds(authored + shift * playbackRate)) + 0;
}

const sourceOf = (element: SourceElement) =>
  element.attrs.src ??
  element.children.find((child) => child.tag === "source")?.attrs.src ??
  null;

/**
 * How HyperFrames loads a composition file. The project's entry document renders its live tree, as
 * the browser builds it, so `<template>` content there is inert. Any other file is loaded as a
 * sub-composition, whose content is its first live `<template>` when it has one.
 *
 * Preview and render both inline sub-compositions through `resolveSubCompositionContent` in
 * `@hyperframes/parsers`, which takes `querySelector("template")` even when a later template is
 * named `<id>-template`. The runtime's in-browser loader prefers `<id>-template`, but it only sees
 * files the bundler skipped, and render refuses those.
 */
export type CompositionScope = "document" | "sub-composition";
export const compositionScope = (path: string): CompositionScope =>
  path === "index.html" ? "document" : "sub-composition";

/** The elements a composition renders in its scope; projection, readback, and media all use it. */
export function scopeElements(
  roots: SourceElement[],
  scope: CompositionScope,
): SourceElement[] {
  const live = [...descendants(roots)];
  const template =
    scope === "sub-composition"
      ? live.find((element) => element.tag === "template")
      : undefined;
  return template ? [...descendants(template.content)] : live;
}

/** Local or remote media references, as authored `src` values. */
export function mediaSources(
  html: string,
  scope: CompositionScope,
  { images = false }: { images?: boolean } = {},
): string[] {
  return [
    ...new Set(
      scopeElements(parseElements(html).roots, scope)
        .filter(
          ({ tag }) =>
            tag === "video" || tag === "audio" || (images && tag === "img"),
        )
        .flatMap((element) => sourceOf(element) ?? []),
    ),
  ];
}

/**
 * Reads `data-fps` the way HyperFrames does: absent means 30, and anything `parseFps` rejects,
 * decimals like 29.97 included, is refused rather than projected at a rate the runtime ignores.
 */
function compositionFps(raw: string | undefined): Fps {
  const parsed = parseFpsWithDefault(raw);
  if (parsed.ok) return parsed.value;
  const ignored = `HyperFrames ignores data-fps="${raw}" and plays the composition at 30 fps.`;
  if (parsed.reason !== "ambiguous-decimal")
    throw new TimelineError(
      "unsupported",
      `${ignored} Use a whole number from 1 to 240 or a fraction such as 30000/1001.`,
    );
  const decimal = Number(raw);
  const ntsc = Math.round(decimal * 1.001);
  throw new TimelineError(
    "unsupported",
    ntsc > 1 && Math.abs((ntsc * 1000) / 1001 - decimal) < 0.005
      ? `${ignored} Write the exact rate, data-fps="${ntsc * 1000}/1001".`
      : `${ignored} Write it as a whole number or a fraction.`,
  );
}

/** Shared source-to-clip projection for the timeline and isolated picture bridge. */
function projectComposition(
  html: string,
  {
    scope = "document",
    mediaLengths = new Map(),
    rootId,
  }: {
    scope?: CompositionScope;
    /** A bundled scene instance whose tracks are mixed independently of its parent. */
    rootId?: string;
    /** Measured source lengths in seconds, by `src`. */
    mediaLengths?: ReadonlyMap<string, number>;
  } = {},
) {
  const { roots, nodes, owned } = parseElements(html);
  const rootOf = (elements: SourceElement[]) =>
    elements.find(
      (element) =>
        element.attrs["data-root"] === "true" &&
        element.attrs["data-composition-id"] !== undefined,
    ) ??
    elements.find(
      (element) => element.attrs["data-composition-id"] !== undefined,
    );
  const all = scopeElements(roots, scope);
  const root =
    rootId === undefined
      ? rootOf(all)
      : all.find((element) => element.attrs["data-composition-id"] === rootId);
  if (!root)
    throw new TimelineError(
      "unsupported",
      scope === "document"
        ? "This file has no live element with data-composition-id."
        : "This sub-composition has no element with data-composition-id.",
    );
  const fps = compositionFps(root.attrs["data-fps"]);
  const byId = new Map<string, SourceElement>();
  for (const element of all)
    if (element.attrs.id && !byId.has(element.attrs.id))
      byId.set(element.attrs.id, element);
  const lengthOf = (element: SourceElement) => {
    if (element.tag !== "video" && element.tag !== "audio") return null;
    const src = sourceOf(element);
    return src ? (mediaLengths.get(src) ?? null) : null;
  };

  type Timing = ClipTiming & { begin: number; finish: number | null };
  const timings = new Map<SourceElement, Timing>();
  const resolving = new Set<SourceElement>();
  const timing = (element: SourceElement): Timing => {
    const known = timings.get(element);
    if (known) return known;
    resolving.add(element);
    const attribute = (name: string) => element.attrs[name] ?? null;
    const read = readClipTiming(
      { getAttribute: attribute },
      {
        resolveReferenceEnd: (refId) => {
          const target = byId.get(refId);
          // A reference cycle resolves to nothing, as in the runtime.
          if (!target || resolving.has(target)) return null;
          const resolved = timing(target);
          return resolved.finish ?? resolved.begin;
        },
      },
    );
    resolving.delete(element);
    const begin = read.start ?? 0;
    const kind = clipKind(element);
    const duration =
      read.duration ??
      (kind === "image" ? DEFAULT_IMAGE_TIMELINE_DURATION_SECONDS : null) ??
      (kind === "video" || isAudioKind(kind)
        ? resolveMediaDuration({
            tag: isAudioKind(kind) ? "audio" : "video",
            authoredDurationSeconds: null,
            sourceDurationSeconds: lengthOf(element),
            mediaStartSeconds: readMediaOffsetSeconds(attribute),
            playbackRate: readPlaybackRate(attribute),
          }).seconds
        : null);
    const result = {
      ...read,
      begin,
      finish: duration === null ? null : begin + duration,
    };
    timings.set(element, result);
    return result;
  };

  const rows: {
    id: string;
    element: SourceElement;
    read: Timing;
    start: number;
    end: number | null;
    edges: ReturnType<typeof readTransitions>;
  }[] = [];
  const clipIds = new Map<SourceElement, string>();
  const used = new Set<string>();
  const anonymous = new Set<string>();
  let synthetic = 0;
  for (const element of topLevelElements(root)) {
    if (element.attrs["data-start"] === undefined) continue;
    const read = timing(element);
    if (read.trackIndex < 0)
      throw new TimelineError(
        "unsupported",
        `Clip ${element.attrs.id || element.attrs["data-hf-id"] || "clip"} has a negative data-track-index.`,
      );
    let start = toFrames(read.begin, fps);
    let end = read.finish === null ? null : toFrames(read.finish, fps);
    // Shorter than a frame is never on screen, and the editor cannot address it.
    if (end !== null && end <= start) continue;
    // The clip is the element less the media it plays under its transitions.
    let edges = takesTransition({ kind: clipKind(element) })
      ? readTransitions(element.attrs, fps)
      : { in: null, out: null };
    const before = edges.in ? framesBefore(edges.in) : 0;
    const after = edges.out ? framesAfter(edges.out) : 0;
    if (end !== null && end - start - before - after >= 1) {
      start += before;
      end -= after;
    } else edges = { in: null, out: null };
    // Clips without a unique id get a positional stand-in; edits locate them by offset, not id.
    let id = element.attrs.id || element.attrs["data-hf-id"];
    while (!id || used.has(id) || (id !== element.attrs.id && byId.has(id)))
      id = `clip-${++synthetic}`;
    if (!element.attrs.id) anonymous.add(id);
    used.add(id);
    clipIds.set(element, id);
    rows.push({ id, element, read, start, end, edges });
  }

  return {
    roots,
    nodes,
    owned,
    all,
    root,
    fps,
    byId,
    rows,
    anonymous,
    clipIds,
    timing,
    lengthOf,
  };
}

/** Timeline identities keyed by source offset; the preview never invents its own clip names. */
export function compositionClipLocations(
  html: string,
  scope: CompositionScope = "document",
  mediaLengths: ReadonlyMap<string, number> = new Map(),
) {
  return new Map(
    projectComposition(html, { scope, mediaLengths }).rows.map(
      ({ id, element }) => [element.start, id],
    ),
  );
}

/** Projects composition HTML and its sidecar settings onto the frames the runtime shows. */
export function parseComposition(
  html: string,
  settings: TimelineSettings,
  {
    scope = "document",
    mediaLengths = new Map(),
    rootId,
    fonts = new Set(declaredFonts(html)),
  }: {
    scope?: CompositionScope;
    /** A bundled scene instance whose tracks are mixed independently of its parent. */
    rootId?: string;
    /** Font faces available from this composition and the project's entry document. */
    fonts?: ReadonlySet<string>;
    /** Measured source lengths in seconds, by `src`. */
    mediaLengths?: ReadonlyMap<string, number>;
  } = {},
): ParsedComposition {
  const {
    roots,
    nodes,
    owned,
    all,
    root,
    fps,
    byId,
    rows: projected,
    anonymous,
    clipIds,
    timing,
    lengthOf,
  } = projectComposition(html, { scope, mediaLengths, rootId });
  const rows = projected.map(({ id, element, read, start, end, edges }) => {
    const name = element.attrs.id || element.attrs["data-hf-id"] || "clip";
    if (end === null)
      throw new TimelineError(
        "unsupported",
        element.tag === "video" || element.tag === "audio"
          ? `Clip ${name} has no data-duration and its media length could not be measured.`
          : `Clip ${name} has no data-duration. Add one to edit it on the timeline.`,
      );
    return { id, element, read, start, end, edges };
  });

  // CSS selectors, inheritance and external sheets are not a CSS cascade we
  // can resolve in this parser. Keep multiline source visible and refuse uncertain rewrites.
  const sharedWhiteSpace = all.some(
    (element) =>
      ["pre", "textarea"].includes(element.tag) ||
      (element.tag === "style" &&
        /white-space\s*:/i.test(html.slice(element.openEnd, element.end))) ||
      (element.tag === "link" &&
        /\bstylesheet\b/i.test(element.attrs.rel ?? "")),
  );
  const inlineWhiteSpace = all.filter((element) =>
    /white-space\s*:/i.test(element.attrs.style ?? ""),
  );
  const textLayout: ParsedComposition["textLayout"] = new Map();
  for (const { element } of rows) {
    const preserveLines =
      sharedWhiteSpace ||
      inlineWhiteSpace.length > 0 ||
      ["pre", "textarea"].includes(element.tag);
    const multiline = elementText(element, true)?.text.includes("\n");
    const inlinePreLine =
      !sharedWhiteSpace &&
      inlineWhiteSpace.length === 1 &&
      inlineWhiteSpace[0] === element &&
      /(?:^|;)\s*white-space\s*:\s*pre-line\s*(?:!important\s*)?(?:;|$)/i.test(
        element.attrs.style ?? "",
      );
    textLayout.set(element, {
      preserveLines,
      ...(preserveLines &&
        multiline &&
        !inlinePreLine && {
          reason:
            "This text may preserve source line breaks. Edit it in the source.",
        }),
    });
  }
  const groupDeclarations = compositionAudioGroups(root);
  const managedGroups = new Set(
    managedAudioGroups(root).map((bus) => bus.attrs.id),
  );
  const authoredMembers = new Set<SourceElement>();
  const clips = rows.map(({ id, element, read, start, end, edges }): Clip => {
    const kind = clipKind(element);
    const title =
      kind === "element" ? readElementTitle(element, fps, fonts) : null;
    const attribute = (name: string) => element.attrs[name] ?? null;
    const reference =
      read.startExpression?.kind === "reference" && read.start !== null
        ? byId.get(read.startExpression.refId)
        : undefined;
    const referenced = reference && clipIds.get(reference);
    const referencedEnd = reference && timing(reference).finish;
    const volume = parseNumeric(element.attrs["data-volume"]);
    const style = readClipStyle(element.attrs.style);
    // Stored at element-local frames; the element starts before the clip under a transition.
    const keyframes = isAudioKind(kind)
      ? null
      : shiftKeyframes(
          readKeyframes(element.attrs[KEYFRAMES_ATTRIBUTE], fps),
          edges.in ? framesBefore(edges.in) : 0,
        );
    const keyed = keyframes ?? {};
    const group = element.attrs["data-audio-group"];
    const authoredGroup = group && !managedGroups.has(group);
    const playbackRate = readPlaybackRate(attribute);
    const hasAudio = isAudioKind(kind) || hasVideoAudio(element);
    if (authoredGroup && hasAudio) authoredMembers.add(element);
    const colorVariable = readColourVariable(element.attrs.style);
    const adjustment =
      kind === "element" && element.attrs[ADJUSTMENT_ATTRIBUTE] !== undefined;
    const imageVariable =
      kind === "image" ? element.attrs["data-var-src"] : undefined;
    const src =
      kind === "composition"
        ? (element.attrs["data-composition-src"] ?? null)
        : kind === "element"
          ? null
          : sourceOf(element);
    const versions = readVersions(kind, src, element.attrs[VERSIONS_ATTRIBUTE]);
    const clip: Clip = {
      id,
      track: read.trackIndex,
      kind,
      start,
      duration: end - start,
      mediaStart:
        kind === "video" || isAudioKind(kind) || kind === "composition"
          ? sourceAtFirstFrame(
              readMediaOffsetSeconds(attribute),
              frameTime(start, fps) - read.begin,
              playbackRate,
            )
          : null,
      playbackRate,
      src,
      sourceDuration: lengthOf(element),
      hasAudio,
      link: element.attrs["data-link"] || null,
      label:
        element.attrs["data-timeline-label"] ??
        element.attrs["data-label"] ??
        null,
      ...(kind === "element" &&
        !adjustment && { textPreview: firstTextLine(element.text) }),
      ...(authoredGroup &&
        hasAudio && {
          authoredAudioGroupId: group,
          trackGainWarning: trackGainWarning(group),
        }),
      volume: volume !== null && volume >= 0 ? volume : null,
      // A keyframed property has no static value: its animation draws over any.
      opacity: keyed.opacity ? null : style.opacity,
      x:
        isAudioKind(kind) || keyed.position
          ? null
          : readPosition(element.attrs, "x"),
      y:
        isAudioKind(kind) || keyed.position
          ? null
          : readPosition(element.attrs, "y"),
      scaleX: isAudioKind(kind) || keyed.scale ? null : style.scaleX,
      scaleY: isAudioKind(kind) || keyed.scale ? null : style.scaleY,
      rotation: isAudioKind(kind) || keyed.rotation ? null : style.rotation,
      crop: isAudioKind(kind) || keyed.crop ? null : style.crop,
      keyframes,
      text:
        kind === "element" && !adjustment
          ? (elementText(element, textLayout.get(element)?.preserveLines)
              ?.text ?? null)
          : null,
      ...((element.attrs["data-var-text"] ||
        colorVariable ||
        imageVariable) && {
        variableBindings: {
          ...(element.attrs["data-var-text"] && {
            text: element.attrs["data-var-text"],
          }),
          ...(colorVariable && { color: colorVariable }),
          ...(imageVariable && { image: imageVariable }),
        },
      }),
      title: title && "title" in title ? title.title : null,
      region: isAudioKind(kind)
        ? null
        : readRegion(element.attrs[REGION_ATTRIBUTE], fps),
      adjustment,
      style: isAudioKind(kind) ? {} : readElementStyle(element.attrs.style),
      // A transition's crossfade is its own, not the clip's fade.
      fadeIn: edges.in
        ? 0
        : toFrames(readFadeSeconds(element.attrs["data-fade-in"]), fps),
      fadeOut: edges.out
        ? 0
        : toFrames(readFadeSeconds(element.attrs["data-fade-out"]), fps),
      transitionIn: edges.in,
      transitionOut: edges.out,
      fx: hasAudio ? readableFx(element.attrs["data-fx-chain"]) : [],
      grade: gradedKind(kind)
        ? readableGrade(element.attrs[GRADE_ATTRIBUTE])
        : null,
      automation: element.attrs["data-automation"]
        ? offsetAutomation(
            serializeAutomation(
              parseAutomation(element.attrs["data-automation"]),
            ),
            -frameTime(edges.in ? framesBefore(edges.in) : 0, fps),
          )
        : null,
      enabled:
        element.attrs["data-hidden"] === undefined ||
        element.attrs["data-cutroom-track-hidden"] !== undefined,
      ...(versions && { versions }),
      startRef:
        referenced && typeof referencedEnd === "number"
          ? {
              clipId: referenced,
              offset: start - toFrames(referencedEnd, fps),
            }
          : null,
    };
    // The crossfade envelope is the transitions', not the clip's own automation.
    return isCrossfadeAutomation(element.attrs["data-automation"], clip, fps)
      ? { ...clip, automation: null }
      : clip;
  });

  const rootDuration = parseNumeric(root.attrs["data-duration"]);
  const rootDurationAuthored = rootDuration !== null && rootDuration > 0;
  const masterFx = readableFx(root.attrs["data-fx-chain"]);
  const authoredAudioGroups = readAuthoredAudioGroups(
    groupDeclarations,
    all,
    authoredMembers,
    scope,
  );
  const timeline = normalizeTimeline({
    fps,
    duration: rootDurationAuthored
      ? toFrames(rootDuration, fps)
      : clips.reduce(
          (max, clip) => Math.max(max, clip.start + clip.duration),
          0,
        ),
    tracks: settings.tracks,
    clips,
    markers: settings.markers.map(({ time, duration, ...marker }) => ({
      ...marker,
      frame: toFrames(time, fps),
      duration: toFrames(duration, fps),
    })),
    range: {
      in: settings.range.in === null ? null : toFrames(settings.range.in, fps),
      out:
        settings.range.out === null ? null : toFrames(settings.range.out, fps),
    },
    ...(authoredAudioGroups.length && { authoredAudioGroups }),
    ...(masterFx.length && { masterFx }),
  });
  const parsed: ParsedComposition = {
    html,
    timeline,
    roots,
    scope,
    root,
    rootDurationAuthored,
    textLayout,
    elements: new Map(rows.map(({ id, element }) => [id, element])),
    anonymous,
    ids: new Set(byId.keys()),
    nodes,
    owned,
    scripts: all
      .filter((element) => element.tag === "script")
      .map((element) => html.slice(element.openEnd, element.end)),
    scriptsAndStyles: all
      .filter(
        (element) =>
          element.tag === "script" ||
          (element.tag === "style" &&
            element.attrs["data-cutroom-track-stacking"] === undefined &&
            element.attrs["data-cutroom-titles"] === undefined &&
            element.attrs[TRANSITION_STYLE_ATTRIBUTE] === undefined &&
            element.attrs[KEYFRAME_STYLE_ATTRIBUTE] === undefined &&
            element.attrs[REGION_STYLE_ATTRIBUTE] === undefined),
      )
      .map((element) => html.slice(element.openEnd, element.end)),
    fonts,
  };
  parsed.timeline = {
    ...timeline,
    ...(fonts.size > 0 && { fonts: [...fonts] }),
    clips: timeline.clips.map((clip) => {
      const restrictions = sourceRestrictions(parsed, clip);
      return restrictions
        ? { ...clip, sourceRestrictions: restrictions }
        : clip;
    }),
  };
  return parsed;
}

/** Source restrictions describe the current document; they are not authored timeline content. */
export function timelineContent(timeline: Timeline) {
  return {
    ...timeline,
    ...(timeline.authoredAudioGroups && {
      authoredAudioGroups: timeline.authoredAudioGroups.map(
        ({ sourceRestriction, ...group }) => group,
      ),
    }),
    clips: timeline.clips.map(
      ({ sourceRestrictions, variableBindings, ...clip }) => clip,
    ),
  };
}

export function settingsOf(timeline: Timeline): TimelineSettings {
  const seconds = (frame: number | null) =>
    frame === null ? null : toSeconds(frame, timeline.fps);
  return {
    tracks: timeline.tracks,
    markers: timeline.markers.map(({ frame, duration, ...marker }) => ({
      ...marker,
      time: toSeconds(frame, timeline.fps),
      duration: toSeconds(duration, timeline.fps),
    })),
    range: { in: seconds(timeline.range.in), out: seconds(timeline.range.out) },
  };
}

interface Edit {
  start: number;
  end: number;
  text: string;
}
export type AttributeChange = readonly [name: string, value: string | null];

function escapeAttribute(value: string, quote = '"'): string {
  const escaped = value.replaceAll("&", "&amp;");
  return quote === "'"
    ? escaped.replaceAll("'", "&#39;")
    : escaped.replaceAll('"', "&quot;");
}

function leadingSpace(html: string, at: number): number {
  while (at > 0 && /[\t\n\f\r ]/.test(html[at - 1]!)) at--;
  return at;
}

/**
 * Attribute offsets of an element's opening tag. The attribute scanner must find a tag at the
 * offsets the parser reported, or the tag is not edited.
 */
function openingTag(
  spans: ReadonlyMap<number, HtmlOpeningTagSpan>,
  element: SourceElement,
  name: string,
): HtmlOpeningTagSpan {
  const span = spans.get(element.start);
  if (!span?.closed || span.end !== element.openEnd)
    throw new TimelineError(
      "unsupported",
      `Clip ${name}'s opening tag cannot be edited safely. Edit it in the source instead.`,
    );
  return span;
}

/**
 * Index of the first owned range whose `reach` passes `offset`. No range before it can end after
 * `offset`, and `reach` only grows, so the search is sound even though ends are not sorted.
 */
function firstReachingPast(owned: OwnedBytes[], offset: number): number {
  let low = 0;
  let high = owned.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (owned[middle]!.reach <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The end of an element that owns its source bytes: every start tag, end tag, and text there
 * belongs to its subtree, and its whole subtree is there. Otherwise removing or copying those bytes
 * would take markup the browser places elsewhere, like a `<div>` written inside a `<table>`, text
 * merged into the text before it, or the `</b>` that closes a bold begun outside it.
 */
function elementEnd(
  parsed: ParsedComposition,
  element: SourceElement,
  name: string,
): number {
  const last = element.index + element.inner;
  const { nodes, owned } = parsed;
  let foreign = nodes
    .slice(element.index, last + 1)
    .some((node) => node.start < element.start || node.end > element.end);
  // Only ranges from the first that reaches past the element's start, up to its end, can overlap it.
  for (
    let at = firstReachingPast(owned, element.start);
    !foreign && at < owned.length && owned[at]!.start < element.end;
    at++
  ) {
    const range = owned[at]!;
    foreign =
      range.end > element.start &&
      (range.node < element.index || range.node > last);
  }
  if (foreign)
    throw new TimelineError(
      "unsupported",
      `Clip ${name} contains markup the browser places outside it, so it cannot be cut or removed here. Edit it in the source instead.`,
    );
  return element.end;
}

/** Rewrites only the named attributes, keeping their quoting and every other byte. */
function attributeEdits(
  span: HtmlOpeningTagSpan,
  html: string,
  changes: AttributeChange[],
): Edit[] {
  const edits: Edit[] = [];
  let added = "";
  for (const [name, value] of changes) {
    const attribute = span.attributes.find((item) => item.name === name);
    if (!attribute) {
      if (value !== null) added += ` ${name}="${escapeAttribute(value)}"`;
    } else if (value === null) {
      edits.push({
        start: leadingSpace(html, attribute.start),
        end: attribute.end,
        text: "",
      });
    } else if (
      attribute.kind === "value" &&
      (attribute.quote || /^[^\s"'=<>`&]+$/.test(value))
    ) {
      edits.push({
        start: attribute.valueStart,
        end: attribute.valueEnd,
        text: escapeAttribute(value, attribute.quote),
      });
    } else {
      edits.push({
        start: attribute.start,
        end: attribute.end,
        text: `${name}="${escapeAttribute(value)}"`,
      });
    }
  }
  if (added) {
    const at = span.attributes.at(-1)?.end ?? span.start + 1 + span.name.length;
    edits.push({ start: at, end: at, text: added });
  }
  return edits;
}

function applyEdits(source: string, edits: Edit[]): string {
  let output = "";
  let cursor = 0;
  for (const edit of edits.toSorted(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    if (edit.start < cursor) throw new Error("Timeline edits overlap.");
    output += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return output + source.slice(cursor);
}

const isManagedAudioGroup = (element: SourceElement) =>
  element.attrs["data-cutroom-track"] !== undefined;
const ROUTED_AUDIO_GROUP = "data-cutroom-audio-group";

function audioGroupElements(elements: SourceElement[]) {
  const mountedTemplates = new Set<string>();
  for (const { attrs, children } of elements) {
    if (attrs["data-composition-src"] !== undefined || children.length)
      continue;
    const id = (
      attrs["data-hf-original-composition-id"] ?? attrs["data-composition-id"]
    )?.trim();
    if (id) mountedTemplates.add(`${id}-template`);
  }
  if (!mountedTemplates.size) return elements;
  return [
    ...elements,
    ...elements.flatMap(({ tag, attrs, content }) =>
      tag === "template" && attrs.id && mountedTemplates.has(attrs.id)
        ? [...descendants(content)]
        : [],
    ),
  ];
}

const audioGroupMember = (element: SourceElement) =>
  element.tag === "audio" || hasVideoAudio(element)
    ? element.attrs["data-audio-group"]
    : undefined;

function managedAudioGroups(root: SourceElement): SourceElement[] {
  return root.children.flatMap((element) => {
    if (element.tag === "hf-audio-group" && isManagedAudioGroup(element))
      return [element];
    if (
      isSubCompositionHost(element) ||
      element.attrs["data-start"] !== undefined ||
      element.tag === "template"
    )
      return [];
    return managedAudioGroups(element);
  });
}

/** Only buses in this composition belong to its timeline. */
function compositionAudioGroups(root: SourceElement): SourceElement[] {
  return root.children.flatMap((element) => {
    if (
      isSubCompositionHost(element) ||
      isTimedElement(element) ||
      element.tag === "template"
    )
      return [];
    if (element.tag === "hf-audio-group") return [element];
    return compositionAudioGroups(element);
  });
}

function readAuthoredAudioGroups(
  declarations: readonly SourceElement[],
  all: SourceElement[],
  authoredMembers: ReadonlySet<SourceElement>,
  scope: CompositionScope,
): NonNullable<Timeline["authoredAudioGroups"]> {
  const buses = new Map<string, SourceElement>();
  for (const element of declarations) {
    const id = element.attrs.id;
    if (id && !isManagedAudioGroup(element) && !buses.has(id))
      buses.set(id, element);
  }
  if (!buses.size) return [];
  const duplicates = new Set<string>();
  const externalMembers = new Set<string>();
  let hasExternalScene = false;
  for (const element of audioGroupElements(all)) {
    const { id } = element.attrs;
    const group = audioGroupMember(element);
    if (id && buses.has(id) && buses.get(id) !== element) duplicates.add(id);
    if (element.attrs["data-composition-src"]) hasExternalScene = true;
    // The runtime can resolve a member outside this timeline to a bus inside it.
    if (group && !authoredMembers.has(element)) externalMembers.add(group);
  }
  return [...buses].map(([id, element]) => {
    // Match HyperFrames readAudioGroupVolume, including its parseFloat semantics.
    const gain = Number.parseFloat(element.attrs["data-volume"] ?? "");
    const cutroomGroup =
      id.startsWith(CUTROOM_AUDIO_GROUP_PREFIX) &&
      element.attrs[ROUTED_AUDIO_GROUP] !== undefined;
    const sourceRestriction = duplicates.has(id)
      ? `Audio group ${id} does not have a unique element id. Edit it in the source.`
      : externalMembers.has(id)
        ? `Audio group ${id} has members outside this timeline. Edit it in the source.`
        : !cutroomGroup && (scope === "sub-composition" || hasExternalScene)
          ? `External scenes can share audio group ${id}. Edit its gain in the source.`
          : undefined;
    return {
      id,
      volume: Number.isFinite(gain) ? gain : 1,
      ...(element.attrs["data-label"] && {
        label: element.attrs["data-label"],
      }),
      ...(sourceRestriction && { sourceRestriction }),
    };
  });
}

/** The attribute changes that turn `before` into `after` on `element`. */
function clipChanges(
  before: Clip,
  after: Clip,
  element: SourceElement,
  fps: Fps,
  normalizeTracks: boolean,
  mix: TrackMix,
): AttributeChange[] {
  const has = (name: string) => element.attrs[name] !== undefined;
  const changes: AttributeChange[] = [];
  const writeStart =
    after.startRef === null &&
    (before.start !== after.start || before.startRef !== null);
  if (writeStart)
    changes.push(["data-start", String(toSeconds(after.start, fps))]);
  if (after.authoredAudioGroupId !== before.authoredAudioGroupId)
    changes.push(["data-audio-group", after.authoredAudioGroupId ?? null]);
  // Start and duration are written together so both land on the frame grid.
  if (writeStart || before.duration !== after.duration) {
    changes.push(["data-duration", String(toSeconds(after.duration, fps))]);
    if (has("data-end")) changes.push(["data-end", null]);
  }
  if (
    before.track !== after.track ||
    (normalizeTracks &&
      !isAudioKind(after.kind) &&
      element.attrs["data-track-index"] !== String(after.track))
  ) {
    changes.push(["data-track-index", String(after.track)]);
    if (has("data-layer")) changes.push(["data-layer", null]);
  }
  const mediaStart =
    after.mediaStart === null ? null : canonicalSeconds(after.mediaStart) + 0;
  const authoredMediaStart = canonicalSeconds(
    readMediaOffsetSeconds((name) => element.attrs[name] ?? null),
  );
  if (
    mediaStart !== null &&
    (mediaStart !== before.mediaStart ||
      (writeStart && authoredMediaStart !== mediaStart))
  )
    changes.push([
      has("data-playback-start") ||
      (!has("data-media-start") && after.kind === "composition")
        ? "data-playback-start"
        : "data-media-start",
      String(mediaStart),
    ]);
  if (before.playbackRate !== after.playbackRate)
    changes.push(["data-playback-rate", String(after.playbackRate)]);
  if (before.x !== after.x || before.y !== after.y)
    changes.push(...positionAttributes(element.attrs, after));
  const [styleBefore, styleAfter] = [clipStyle(before), clipStyle(after)];
  const style = Object.fromEntries(
    Object.entries(styleAfter).filter(
      ([property, value]) =>
        styleBefore[property as keyof typeof styleBefore] !== value,
    ),
  );
  if (Object.keys(style).length)
    changes.push(["style", writeClipStyle(element.attrs.style, style)]);
  const keyframes = keyframesAttribute(after.keyframes, fps);
  if (keyframesAttribute(before.keyframes, fps) !== keyframes)
    changes.push([KEYFRAMES_ATTRIBUTE, keyframes]);
  if (before.volume !== after.volume)
    changes.push([
      "data-volume",
      after.volume === null ? null : String(after.volume),
    ]);
  for (const [field, attribute] of [
    ["fadeIn", "data-fade-in"],
    ["fadeOut", "data-fade-out"],
  ] as const)
    if (before[field] !== after[field])
      changes.push([
        attribute,
        after[field] ? String(toSeconds(after[field], fps)) : null,
      ]);
  if (before.automation !== after.automation)
    changes.push(["data-automation", after.automation]);
  if (!Bun.deepEquals(before.grade, after.grade))
    changes.push([GRADE_ATTRIBUTE, writeGrade(after.grade)]);
  if (!Bun.deepEquals(before.fx, after.fx))
    changes.push([
      "data-fx-chain",
      writeFxChain(after.fx, element.attrs["data-fx-chain"]),
    ]);
  if (before.label !== after.label) {
    if (after.label === null)
      changes.push(["data-timeline-label", null], ["data-label", null]);
    else
      changes.push([
        has("data-label") && !has("data-timeline-label")
          ? "data-label"
          : "data-timeline-label",
        after.label,
      ]);
  }
  if (before.link !== after.link) changes.push(["data-link", after.link]);
  if (!sameRegion(before.region, after.region))
    changes.push([
      REGION_ATTRIBUTE,
      after.region && regionAttribute(after.region, fps),
    ]);
  if (after.title && !Bun.deepEquals(before.title, after.title)) {
    const written = new Map(
      before.title ? titleAttributes(before.title, fps) : [],
    );
    changes.push(
      ...titleAttributes(after.title, fps).filter(
        ([name, value]) => (written.get(name) ?? null) !== value,
      ),
    );
  }
  const hidden = !after.enabled || mix.hidden.has(after.track);
  const trackHidden = after.enabled && mix.hidden.has(after.track);
  if (has("data-hidden") !== hidden)
    changes.push(["data-hidden", hidden ? "" : null]);
  if (has("data-cutroom-track-hidden") !== trackHidden)
    changes.push(["data-cutroom-track-hidden", trackHidden ? "" : null]);
  // Muting embedded sound must keep the picture visible and preserve the authored mute.
  const soundOff =
    after.kind === "video" &&
    after.hasAudio &&
    (!after.enabled || mix.muted.has(after.track));
  const authoredMuted = has("muted") && !has("data-cutroom-muted");
  if (has("muted") !== (authoredMuted || soundOff))
    changes.push(["muted", authoredMuted || soundOff ? "" : null]);
  if (has("data-cutroom-muted") !== (soundOff && !authoredMuted))
    changes.push([
      "data-cutroom-muted",
      soundOff && !authoredMuted ? "" : null,
    ]);
  return changes;
}

/** Replaces a text element's words, keeping the whitespace that indents them in the source. */
function textEdit(
  parsed: ParsedComposition,
  element: SourceElement,
  text: string,
): Edit {
  // The engine refused restricted text before this, so the element has a closing tag.
  const close = parsed.nodes[element.index]!.own[1]!;
  const inner = parsed.html.slice(element.openEnd, close[0]);
  return {
    start: element.openEnd + /^[\t\n\f\r ]*/.exec(inner)![0].length,
    end: close[0] - /[\t\n\f\r ]*$/.exec(inner)![0].length,
    text: textMarkup(text),
  };
}

/**
 * Sets or removes attributes on the element with `id`, rewriting only those attributes' bytes so
 * every other byte of the file stays as written. Null when no element has that id.
 */
export function setElementAttributes(
  html: string,
  id: string,
  changes: readonly AttributeChange[],
): string | null {
  const element = [...descendants(parseElements(html).roots)].find(
    (item) => item.attrs.id === id,
  );
  if (!element) return null;
  return rewriteAttributes(html, element, id, changes);
}

/** Bind only a unique authored id in the currently projected composition. */
export function bindCompositionVariable(
  parsed: ParsedComposition,
  clipId: string,
  to: VariableBinding["to"],
  variableId: string,
  existing = true,
): string {
  const clip = parsed.timeline.clips.find((item) => item.id === clipId);
  const element = parsed.elements.get(clipId);
  const idAttribute =
    to === "image" && !element?.attrs.id ? "data-hf-id" : "id";
  if (!clip || !element || element.attrs[idAttribute] !== clipId)
    throw new TimelineError(
      "unsupported",
      `No clip with authored id ${clipId}.`,
    );
  if (
    scopeElements(parsed.roots, parsed.scope).filter(
      (item) => item.attrs[idAttribute] === clipId,
    ).length !== 1
  )
    throw new TimelineError(
      "unsupported",
      `${clipId} is not a unique element id.`,
    );
  if (
    parsed.timeline.tracks.find((track) => track.index === clip.track)?.locked
  )
    throw new TimelineError("unsupported", `${clipId}'s track is locked.`);
  if (to === "image") {
    if (clip.kind !== "image")
      throw new TimelineError(
        "unsupported",
        "Bind an image variable to an image clip.",
      );
    if (clip.sourceRestrictions?.imageVariable)
      throw new TimelineError(
        "unsupported",
        clip.sourceRestrictions.imageVariable,
      );
    return rewriteAttributes(parsed.html, element, clipId, [
      ["data-var-src", variableId],
    ]);
  }
  if (
    clip.kind !== "element" ||
    clip.title ||
    ((existing || to === "text") &&
      (clip.text === null ||
        clip.text.includes("\n") ||
        clip.sourceRestrictions?.text))
  )
    throw new TimelineError(
      "unsupported",
      "Bind only ordinary text elements with one line of plain words. Titles keep their own settings.",
    );
  if (
    existing &&
    to === "color" &&
    !clip.style.color &&
    !clip.variableBindings?.color
  )
    throw new TimelineError(
      "unsupported",
      "Bind a text colour only when the element has an explicit inline colour.",
    );
  return rewriteAttributes(
    parsed.html,
    element,
    clipId,
    to === "text"
      ? [["data-var-text", variableId]]
      : [
          [
            "style",
            writeClipStyle(element.attrs.style, {
              color: `var(--${variableId})`,
            })!,
          ],
        ],
  );
}

function rewriteAttributes(
  html: string,
  element: SourceElement,
  name: string,
  changes: readonly AttributeChange[],
) {
  const spans = new Map(
    scanHtmlOpeningTags(html).map((span) => [span.start, span]),
  );
  return applyEdits(
    html,
    attributeEdits(openingTag(spans, element, name), html, [...changes]),
  );
}

/** The attributes of the element with `id`, as written. Null when no element has that id. */
export function elementAttributes(
  html: string,
  id: string,
): Readonly<Record<string, string>> | null {
  return (
    [...descendants(parseElements(html).roots)].find(
      (item) => item.attrs.id === id,
    )?.attrs ?? null
  );
}

const INSTANCE_VALUES_ATTRIBUTE = "data-variable-values";

export function sceneInstanceSource(parsed: ParsedComposition, clipId: string) {
  const clip = parsed.timeline.clips.find((item) => item.id === clipId);
  const element = parsed.elements.get(clipId);
  if (!clip || !element || clip.kind !== "composition" || !clip.src)
    throw new TimelineError(
      "unsupported",
      "Select a clip that mounts an HTML scene.",
    );
  const idAttribute = element.attrs.id ? "id" : "data-hf-id";
  if (
    element.attrs[idAttribute] !== clipId ||
    scopeElements(parsed.roots, parsed.scope).filter(
      (item) => item.attrs[idAttribute] === clipId,
    ).length !== 1
  )
    throw new TimelineError(
      "unsupported",
      "Give this scene clip a unique element ID in Source before editing its variables.",
    );
  const values = parseSceneVariableValues(
    element.attrs[INSTANCE_VALUES_ATTRIBUTE],
  );
  if (!values)
    throw new VariableError(
      "This scene clip's values are not a JSON object. Fix them in Source first.",
    );
  return {
    src: clip.src,
    compositionId: element.attrs["data-composition-id"],
    originalCompositionId: element.attrs["data-hf-original-composition-id"],
    locked:
      parsed.timeline.tracks.find((track) => track.index === clip.track)
        ?.locked === true,
    values,
    write(next: Record<string, unknown>) {
      return rewriteAttributes(parsed.html, element, clipId, [
        [
          INSTANCE_VALUES_ATTRIBUTE,
          Object.keys(next).length ? JSON.stringify(next) : null,
        ],
      ]);
    },
  };
}

const VARIABLES_ATTRIBUTE = "data-composition-variables";

/** Live declarations and their source owners, in the order HyperFrames reads them. */
export function sourceVariables(html: string, scope: CompositionScope) {
  const { roots } = parseElements(html);
  const live = scopeElements(roots, scope);
  const page = roots.find((element) => element.tag === "html");
  const root = live.find(
    (element) => element.attrs["data-composition-id"] !== undefined,
  );
  // A mounted scene inherits its HTML document's defaults, then its rendered root's.
  const carriers = scope === "document" ? live : [...new Set([page, root])];
  const written = carriers.flatMap((element) => {
    const raw = element?.attrs[VARIABLES_ATTRIBUTE];
    if (!element || raw === undefined) return [];
    let items: unknown[] | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      // HyperFrames ignores malformed declarations. Keep their source intact.
    }
    return [{ element, items }];
  });
  const entries = written.flatMap(
    ({ element, items }) =>
      items?.flatMap((item) =>
        isCompositionVariable(item) ? [{ element, items, variable: item }] : [],
      ) ?? [],
  );
  const effective = new Map(entries.map((entry) => [entry.variable.id, entry]));
  const write = (element: SourceElement, items: unknown[]) =>
    rewriteAttributes(html, element, `<${element.tag}>`, [
      [VARIABLES_ATTRIBUTE, JSON.stringify(items)],
    ]);
  return {
    declarations: Array.from(effective.values(), ({ variable }) => variable),
    // Later carriers override earlier defaults. Duplicate IDs in one list are ambiguous.
    matches: (id: string) =>
      effective
        .get(id)
        ?.items.filter(isCompositionVariable)
        .filter((variable) => variable.id === id) ?? [],
    add(variable: CompositionVariable) {
      const first = written[0];
      const owner =
        first?.element ??
        (scope === "document" ? (page ?? root) : (root ?? page));
      if (!owner)
        throw new VariableError(
          "This file has no <html> element or composition root to declare variables on.",
        );
      if (first?.items === null)
        throw new VariableError(
          "data-composition-variables is not a JSON list. Fix it in the source first.",
        );
      return write(owner, [...(first?.items ?? []), variable]);
    },
    setDefault(variable: CompositionVariable, value: VariableValue) {
      const owner = effective.get(variable.id);
      if (owner?.variable !== variable)
        throw new VariableError(`${variable.id} has no live declaration.`);
      const next =
        variable.type === "image" && typeof variable.default === "object"
          ? { ...variable.default, url: value }
          : value;
      return write(
        owner.element,
        owner.items.map((item) =>
          item === variable ? { ...variable, default: next } : item,
        ),
      );
    },
  };
}

/** Re-applies sidecar mix state without changing authored timing, stacking, or clip ids. */
export function applyTrackMix(parsed: ParsedComposition): string {
  const { html, timeline } = parsed;
  const spans = new Map(
    scanHtmlOpeningTags(html).map((span) => [span.start, span]),
  );
  const mix = trackMix(timeline.tracks);
  const edits: Edit[] = [];
  const groups = managedAudioGroups(parsed.root);
  const used = new Set([
    ...parsed.ids,
    ...timeline.clips.map((clip) => clip.id),
    ...timeline.clips.flatMap((clip) =>
      clip.authoredAudioGroupId ? [clip.authoredAudioGroupId] : [],
    ),
  ]);
  const memberships = new Map<number, string>();
  const inserted: string[] = [];
  for (const track of timeline.tracks) {
    if (
      track.kind !== "audio" &&
      !timeline.clips.some(
        (clip) => clip.track === track.index && clip.hasAudio,
      )
    )
      continue;
    const group = groups.find(
      (element) => element.attrs["data-cutroom-track"] === String(track.index),
    );
    let id = group?.attrs.id;
    const chain = writeFxChain(track.fx, group?.attrs["data-fx-chain"]);
    if (!id) {
      const base = `cutroom-${parsed.root.attrs["data-composition-id"]}-track-${track.index}`;
      id = base;
      for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
      used.add(id);
      inserted.push(
        `<hf-audio-group id="${escapeAttribute(id)}" data-cutroom-track="${track.index}" data-volume="${track.volume}"${chain ? ` data-fx-chain="${escapeAttribute(chain)}"` : ""}></hf-audio-group>`,
      );
    } else {
      edits.push(
        ...attributeEdits(openingTag(spans, group!, id), html, [
          ["data-volume", String(track.volume)],
          ["data-fx-chain", chain],
        ]),
      );
    }
    memberships.set(track.index, id);
  }
  for (const group of groups) {
    if ([...memberships.values()].includes(group.attrs.id!)) continue;
    edits.push({ start: group.start, end: group.end, text: "" });
  }
  if (inserted.length)
    edits.push({
      start: parsed.root.openEnd,
      end: parsed.root.openEnd,
      text: inserted.join("\n"),
    });
  // Adding membership changes HyperFrames' generated identity hash. Preserve existing preview
  // identities when routing is first persisted, so a fader need not replace the playing document.
  const joining = timeline.clips.some((clip) => {
    const attrs = parsed.elements.get(clip.id)!.attrs;
    return (
      clip.hasAudio &&
      !clip.authoredAudioGroupId &&
      attrs.id &&
      !attrs["data-hf-id"] &&
      attrs["data-audio-group"] !== memberships.get(clip.track)
    );
  });
  const identities = new Map(
    joining
      ? scopeElements(
          parseElements(ensureHfIds(html)).roots,
          parsed.scope,
        ).flatMap(({ attrs }) =>
          attrs.id && attrs["data-hf-id"]
            ? [[attrs.id, attrs["data-hf-id"]] as const]
            : [],
        )
      : [],
  );
  for (const clip of timeline.clips) {
    const element = parsed.elements.get(clip.id)!;
    const changes = clipChanges(clip, clip, element, timeline.fps, false, mix);
    if (clip.hasAudio && !clip.authoredAudioGroupId) {
      changes.push(["data-audio-group", memberships.get(clip.track)!]);
      if (!element.attrs["data-hf-id"] && identities.has(clip.id))
        changes.push(["data-hf-id", identities.get(clip.id)!]);
      // Anonymous media needs a stable id for HyperFrames' render group discovery.
      if (parsed.anonymous.has(clip.id)) changes.push(["id", clip.id]);
    } else if (
      !clip.hasAudio &&
      groups.some(
        (group) => group.attrs.id === element.attrs["data-audio-group"],
      )
    ) {
      changes.push(["data-audio-group", null]);
    }
    edits.push(
      ...attributeEdits(openingTag(spans, element, clip.id), html, changes),
    );
  }
  return applyEdits(html, edits);
}

/** Sidecar settings belong to a file, including every instance of that file in a preview bundle. */
export function mixCompositionInstances(
  html: string,
  settings: TimelineSettings,
  composition: string,
  activeComposition: string,
  mediaLengths: ReadonlyMap<string, number>,
) {
  const canonical = (path: string) =>
    posix.normalize(path.replaceAll("\\", "/")).replace(/^\/+/, "");
  const elements = scopeElements(parseElements(html).roots, "document");
  const root =
    elements.find(
      ({ attrs }) =>
        attrs["data-root"] === "true" &&
        attrs["data-composition-id"] !== undefined,
    ) ??
    elements.find(({ attrs }) => attrs["data-composition-id"] !== undefined);
  const ids = elements.flatMap((element) => {
    const { attrs } = element;
    const id = attrs["data-composition-id"];
    const file = attrs["data-composition-file"];
    return id &&
      (file
        ? canonical(file) === canonical(composition)
        : element === root &&
          canonical(activeComposition) === canonical(composition))
      ? [id]
      : [];
  });
  for (const rootId of ids)
    html = applyTrackMix(
      parseComposition(html, settings, { rootId, mediaLengths }),
    );
  return html;
}

function indentOf(html: string, at: number): string {
  const lineStart = html.lastIndexOf("\n", at - 1) + 1;
  const indent = html.slice(lineStart, at);
  return /^[\t ]*$/.test(indent) ? indent : "";
}

/** Why a clip's words cannot be replaced as plain text, if they cannot. */
function textRestriction(
  parsed: ParsedComposition,
  clip: Clip,
  element: SourceElement,
): string | undefined {
  if (clip.text === null) return undefined;
  if (!elementText(element)?.plain)
    return "This text has markup inside it. Edit it in the source.";
  if (
    element.tag === "pre" ||
    element.tag === "textarea" ||
    /white-space\s*:\s*(?:pre(?:-wrap)?|break-spaces)(?:\s|;|!|$)/i.test(
      element.attrs.style ?? "",
    )
  )
    return "This text keeps its exact spacing. Edit it in the source.";
  const spacing = parsed.textLayout.get(element)?.reason;
  if (spacing) return spacing;
  if (!parsed.nodes[element.index]!.own[1])
    return "This element has no closing tag. Edit it in the source.";
  if (element.attrs.id && scriptWritesText(parsed.scripts, element.attrs.id))
    return "A script sets this text. Edit it in the source.";
  return undefined;
}

/** HyperFrames grades pictures: video and image clips. */
const gradedKind = (kind: Clip["kind"]) => kind === "video" || kind === "image";

/** A clip's grade, or none when Cutroom cannot read it; `sourceRestrictions.grade` says why. */
const readableGrade = (attribute: string | undefined) => {
  const read = readGrade(attribute);
  return "grade" in read ? read.grade : null;
};

/** A clip's effects, or none when its chain cannot be read; `sourceRestrictions.fx` says why. */
const readableFx = (attribute: string | undefined) => {
  try {
    return readFxChain(attribute);
  } catch {
    return [];
  }
};

/** Why a clip's authored effect chain cannot be edited, when Cutroom cannot read it. */
function fxRestriction(attribute: string | undefined) {
  try {
    readFxChain(attribute);
    return undefined;
  } catch (error) {
    return `Its data-fx-chain cannot be read (${error instanceof Error ? error.message : String(error)}). Repair it in the source first.`;
  }
}

/** Project source constraints once so browser and server commands make the same decision. */
function sourceRestrictions(
  parsed: ParsedComposition,
  clip: Clip,
): Clip["sourceRestrictions"] {
  const element = parsed.elements.get(clip.id)!;
  const restrictions = cutAndTextRestrictions(parsed, clip);
  const read =
    clip.kind === "element"
      ? readElementTitle(element, parsed.timeline.fps, parsed.fonts)
      : null;
  const transform = isAudioKind(clip.kind)
    ? undefined
    : readClipStyle(element.attrs.style).restriction;
  const fx = fxRestriction(element.attrs["data-fx-chain"]);
  const graded = readGrade(element.attrs[GRADE_ATTRIBUTE]);
  const grade = gradedKind(clip.kind)
    ? "restriction" in graded
      ? graded.restriction
      : element.attrs["data-color-group"]
        ? "It takes its grade from a colour group. Edit the group in the source."
        : undefined
    : undefined;
  const all = {
    ...restrictions,
    ...(read && "reason" in read && { title: read.reason }),
    ...(transform && { transform }),
    ...(fx && { fx }),
    ...(grade && { grade }),
  };
  if (clip.kind === "image") {
    if (element.insidePicture || Object.hasOwn(element.attrs, "srcset"))
      return { ...all, imageVariable: "Edit this responsive image in Source." };
    if (Object.hasOwn(element.attrs, "data-cutroom-freeze-export"))
      return {
        ...all,
        imageVariable: "A paired freeze frame keeps its source for export.",
      };
    if ((element.attrs.id || element.attrs["data-hf-id"]) !== clip.id)
      return {
        ...all,
        imageVariable: "Add an element ID in Source to bind this image.",
      };
  }
  return Object.keys(all).length ? all : undefined;
}

function cutAndTextRestrictions(
  parsed: ParsedComposition,
  clip: Clip,
): Clip["sourceRestrictions"] {
  const element = parsed.elements.get(clip.id)!;
  const text = textRestriction(parsed, clip, element);
  try {
    elementEnd(parsed, element, clip.id);
  } catch (error) {
    if (!(error instanceof TimelineError)) throw error;
    return {
      copy: error.message,
      remove: error.message,
      ...(clip.text !== null && {
        text: text ?? "This text's markup is misnested. Edit it in the source.",
      }),
    };
  }
  const authoredId = element.attrs.id;
  const escaped = authoredId?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reference =
    escaped && new RegExp(`#${escaped}(?![\\w-])|(["'\`])${escaped}\\1`);
  if (reference && parsed.scriptsAndStyles.some((text) => reference.test(text)))
    return {
      copy: `Clip ${clip.id} is styled or animated by its id, so a cut copy would lose that. Edit it in the source instead.`,
      ...(text && { text }),
    };
  const source = parsed.html.slice(element.start, element.end);
  if (
    scanHtmlOpeningTags(source)
      .slice(1)
      .some((span) => span.attributes.some((item) => item.name === "id"))
  )
    return {
      copy: `Clip ${clip.id} contains elements with ids, which a cut copy would duplicate. Edit it in the source instead.`,
      ...(text && { text }),
    };
  return text ? { text } : undefined;
}

function copyMarkup(
  parsed: ParsedComposition,
  template: Clip,
  clip: Clip,
  normalizeTracks: boolean,
  mix: TrackMix,
  under: { in: boolean; out: boolean },
  hosted: (src: string) => HostedComposition,
): string {
  const element = parsed.elements.get(template.id)!;
  if (template.sourceRestrictions?.copy)
    throw new TimelineError("unsupported", template.sourceRestrictions.copy);
  const source = parsed.html.slice(
    element.start,
    elementEnd(parsed, element, template.id),
  );
  const [first, ...inner] = scanHtmlOpeningTags(source);
  const origin = element.attrs["data-sync-origin"];
  return applyEdits(source, [
    ...attributeEdits(first!, source, [
      ["id", clip.id],
      ["data-hf-id", null],
      ...(!template.authoredAudioGroupId &&
      !clip.authoredAudioGroupId &&
      template.hasAudio
        ? [["data-audio-group", null] as const]
        : []),
      ...clipChanges(
        elementClip(template, parsed.timeline.fps),
        elementClip(clip, parsed.timeline.fps),
        element,
        parsed.timeline.fps,
        normalizeTracks,
        mix,
      ),
      ...versionChanges(template, clip, element.attrs, hosted),
      ...transitionChanges(element.attrs, clip, under, parsed.timeline.fps),
      ...(origin !== undefined &&
      clip.link !== null &&
      clip.link !== template.link
        ? [["data-sync-origin", clip.link] as const]
        : []),
    ]),
    ...inner.flatMap((span) =>
      attributeEdits(span, source, [["data-hf-id", null]]),
    ),
  ]);
}

/** Markup characters in text content; a newline is written as a line break. */
const textMarkup = (text: string) =>
  text
    .split("\n")
    .map((line) =>
      line
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
    )
    .join("<br>");

export const attributeMarkup = (attributes: AttributeChange[]) =>
  attributes
    .map(([name, value]) =>
      value === null ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`,
    )
    .join("");

/** A new title: a plain text element whose attributes the title stylesheet reads. */
function titleMarkup(clip: Clip, fps: Fps, mix: TrackMix): string {
  const hidden = mix.hidden.has(clip.track);
  return `<div${attributeMarkup([
    ["id", clip.id],
    ["class", "clip"],
    ["data-start", String(toSeconds(clip.start, fps))],
    ["data-duration", String(toSeconds(clip.duration, fps))],
    ["data-track-index", String(clip.track)],
    ...(!clip.enabled || hidden ? [["data-hidden", ""] as const] : []),
    ...(clip.enabled && hidden
      ? [["data-cutroom-track-hidden", ""] as const]
      : []),
    ...positionAttributes({}, clip).filter(
      (attribute) => attribute[1] !== null,
    ),
    ...(writeClipStyle(undefined, clipStyle(clip)) !== null
      ? [["style", writeClipStyle(undefined, clipStyle(clip))!] as const]
      : []),
    ...(clip.label !== null
      ? [["data-timeline-label", clip.label] as const]
      : []),
    ...titleAttributes(clip.title!, fps).filter(
      (attribute): attribute is [string, string] => attribute[1] !== null,
    ),
  ])}>${textMarkup(clip.text!)}</div>`;
}

/**
 * The frame size a region's pixels are measured in: the root's declared size, or HyperFrames'
 * default stage.
 */
function compositionSize(root: SourceElement) {
  const length = (name: string, fallback: number) => {
    const value = Number.parseFloat(root.attrs[name] ?? "");
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    width: length("data-width", 1920),
    height: length("data-height", 1080),
  };
}

/** A new adjustment layer: an empty clip the region stylesheet lays over the frame. */
function adjustmentMarkup(clip: Clip, fps: Fps, mix: TrackMix): string {
  const hidden = mix.hidden.has(clip.track);
  return `<div${attributeMarkup([
    ["id", clip.id],
    ["class", "clip"],
    [ADJUSTMENT_ATTRIBUTE, ""],
    ["data-start", String(toSeconds(clip.start, fps))],
    ["data-duration", String(toSeconds(clip.duration, fps))],
    ["data-track-index", String(clip.track)],
    ...(!clip.enabled || hidden ? [["data-hidden", ""] as const] : []),
    ...(clip.enabled && hidden
      ? [["data-cutroom-track-hidden", ""] as const]
      : []),
    ...(clip.label !== null
      ? [["data-timeline-label", clip.label] as const]
      : []),
    [REGION_ATTRIBUTE, regionAttribute(clip.region!, fps)],
  ])}></div>`;
}

/** What a host needs from the composition it plays: the root's id and declared size. */
export interface HostedComposition {
  id: string;
  width: string | null;
  height: string | null;
}

/** A new sub-composition host, written as the documented recipe writes one. */
function hostMarkup(
  clip: Clip,
  hosted: HostedComposition,
  fps: Fps,
  mix: TrackMix,
): string {
  const hidden = mix.hidden.has(clip.track);
  return `<div${attributeMarkup([
    ["id", clip.id],
    ["class", "clip"],
    ["data-composition-id", hosted.id],
    ["data-composition-src", clip.src!],
    ["data-start", String(toSeconds(clip.start, fps))],
    ["data-duration", String(toSeconds(clip.duration, fps))],
    ["data-track-index", String(clip.track)],
    ...(hosted.width !== null ? [["data-width", hosted.width] as const] : []),
    ...(hosted.height !== null
      ? [["data-height", hosted.height] as const]
      : []),
    ...(!clip.enabled || hidden ? [["data-hidden", ""] as const] : []),
    ...(clip.enabled && hidden
      ? [["data-cutroom-track-hidden", ""] as const]
      : []),
    ...(clip.label !== null
      ? [["data-timeline-label", clip.label] as const]
      : []),
    ...versionAttributes(clip),
  ])}></div>`;
}

const fittedMedia =
  "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";

function insertMarkup(
  clip: Clip,
  input: Pick<InsertClip, "src" | "muted">,
  fps: Fps,
  mix: TrackMix,
  transitions: AttributeChange[],
  template?: SourceElement["attrs"],
  exportSrc?: string,
): string {
  const authoredStyle = template
    ? template.style
    : clip.kind === "video" || clip.kind === "image"
      ? fittedMedia
      : undefined;
  const before = clipStyle({
    ...readClipStyle(authoredStyle),
    style: readElementStyle(authoredStyle),
  });
  const styleChanges = Object.fromEntries(
    Object.entries(clipStyle(clip)).filter(
      ([key, value]) => before[key as keyof typeof before] !== value,
    ),
  );
  const style = Object.keys(styleChanges).length
    ? writeClipStyle(authoredStyle, styleChanges)
    : authoredStyle;
  const classes = new Set((template?.class ?? "").split(/\s+/).filter(Boolean));
  if (clip.kind === "image") classes.add("clip");
  const inherited = [
    "width",
    "height",
    "data-color-grading",
    "data-color-group",
  ];
  const keyframes = keyframesAttribute(clip.keyframes, fps);
  const attributes: AttributeChange[] = [
    ["id", clip.id],
    ...(classes.size ? [["class", [...classes].join(" ")] as const] : []),
    ["src", clip.src ?? input.src],
    ...versionAttributes(clip),
    ...(exportSrc ? [[freezeExportSource, exportSrc] as const] : []),
    ...(clip.kind === "voiceover"
      ? [["data-cutroom-kind", "voiceover"] as const]
      : []),
    ...(style ? [["style", style] as const] : []),
    ...inherited.flatMap((name) => {
      const value = template?.[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
    ...positionAttributes(template ?? {}, clip).filter(
      ([, value]) => value !== null,
    ),
    ...(keyframes ? [[KEYFRAMES_ATTRIBUTE, keyframes] as const] : []),
    ["data-start", String(toSeconds(clip.start, fps))],
    ["data-duration", String(toSeconds(clip.duration, fps))],
    ["data-track-index", String(clip.track)],
    ...(clip.link ? [["data-link", clip.link] as const] : []),
    ...(!clip.enabled || mix.hidden.has(clip.track)
      ? [["data-hidden", ""] as const]
      : []),
    ...(clip.enabled && mix.hidden.has(clip.track)
      ? [["data-cutroom-track-hidden", ""] as const]
      : []),
    ...(clip.kind === "video" &&
    clip.hasAudio &&
    (!clip.enabled || mix.muted.has(clip.track))
      ? [["muted", ""] as const, ["data-cutroom-muted", ""] as const]
      : []),
    ...(clip.mediaStart
      ? [
          [
            "data-media-start",
            String(canonicalSeconds(clip.mediaStart)),
          ] as const,
        ]
      : []),
    ...(clip.volume !== null
      ? [["data-volume", String(clip.volume)] as const]
      : []),
    ...(clip.authoredAudioGroupId
      ? [["data-audio-group", clip.authoredAudioGroupId] as const]
      : []),
    ...(
      [
        ["fadeIn", "data-fade-in"],
        ["fadeOut", "data-fade-out"],
      ] as const
    ).flatMap(([field, attribute]) =>
      clip[field]
        ? [[attribute, String(toSeconds(clip[field], fps))] as const]
        : [],
    ),
    ...(clip.label !== null
      ? [["data-timeline-label", clip.label] as const]
      : []),
    ...(clip.kind === "video"
      ? [
          input.muted
            ? (["muted", null] as const)
            : (["data-has-audio", String(clip.hasAudio)] as const),
        ]
      : []),
    ...transitions.filter(([, value]) => value !== null),
  ];
  const text = attributeMarkup(attributes);
  const tag =
    clip.kind === "image"
      ? "img"
      : isAudioKind(clip.kind)
        ? "audio"
        : clip.kind;
  return tag === "img" ? `<img${text}>` : `<${tag}${text}></${tag}>`;
}

/** CSS strings must also keep a composition id from closing the HTML style element. */
function cssString(value: string): string {
  return `"${value.replace(/[\0-\x1f\x7f"\\<]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)}"`;
}

function stylesheetLocation(roots: SourceElement[], scope: CompositionScope) {
  const live = [...descendants(roots)];
  const template =
    scope === "sub-composition"
      ? live.find((element) => element.tag === "template")
      : undefined;
  const head = template
    ? undefined
    : live.find((element) => element.tag === "head");
  return {
    at:
      template?.openEnd ??
      head?.openEnd ??
      live.find((element) => element.tag === "html")?.openEnd ??
      roots[0]?.start ??
      0,
    needsHead: !template && !head && scope === "document",
  };
}

/** Scene styles are hoisted after entry styles, so their shared layer must be declared first. */
export function declareTrackLayer(html: string): string {
  const { roots } = parseElements(html);
  const { at, needsHead } = stylesheetLocation(roots, "document");
  const elements = [...descendants(roots, true)];
  const first = elements.find(
    (element) => element.start === at && element.tag === "style",
  );
  if (
    first &&
    (first.attrs["data-cutroom-track-layer"] !== undefined ||
      first.attrs["data-cutroom-track-stacking"] !== undefined)
  )
    return html;
  const text = `<style data-cutroom-track-layer>@layer cutroom-tracks;</style>`;
  return applyEdits(html, [
    ...elements
      .filter(
        (element) =>
          element.tag === "style" &&
          element.attrs["data-cutroom-track-layer"] !== undefined,
      )
      .map((element) => ({ start: element.start, end: element.end, text: "" })),
    {
      start: at,
      end: at,
      text: needsHead ? `<head>${text}</head>\n` : `${text}\n`,
    },
  ]);
}

/** Owns the defaults' scope and cascade order. */
function stackingEdits(
  parsed: ParsedComposition,
  after: Timeline,
  previous: ReadonlyMap<string, Clip>,
): Edit[] | null {
  const { html, root } = parsed;
  const compositionId = root.attrs["data-composition-id"]!;
  const blocks = [...descendants(parsed.roots, true)].filter(
    (element) =>
      element.tag === "style" &&
      element.attrs["data-cutroom-track-stacking"] === compositionId,
  );
  const placed = after.clips.some((clip) => {
    if (isAudioKind(clip.kind)) return false;
    const prior = previous.get(clip.id);
    return (
      prior === undefined ||
      prior.track !== clip.track ||
      prior.start !== clip.start ||
      prior.duration !== clip.duration
    );
  });
  if (!blocks.length && !placed) return null;

  const scope = `[data-composition-id=${cssString(compositionId)}]`;
  const nested = `${scope} :is([data-start],[data-composition-id],[data-composition-src]) *`;
  const tracks = new Set(
    after.clips
      .filter((clip) => !isAudioKind(clip.kind))
      .map((clip) => clip.track),
  );
  const rules = [...tracks]
    .sort((a, b) => a - b)
    .map(
      (index) =>
        `:where(${scope} [data-start][data-track-index="${index}"]:not(audio):not(${nested})){z-index:${index}}`,
    )
    .join("");
  const text = `<style data-cutroom-track-stacking="${escapeAttribute(compositionId)}">@layer cutroom-tracks{${rules}}</style>`;
  const { at, needsHead } = stylesheetLocation(parsed.roots, parsed.scope);
  if (blocks.length === 1 && blocks[0]!.start === at && !needsHead)
    return html.slice(at, blocks[0]!.end) === text
      ? []
      : [{ start: at, end: blocks[0]!.end, text }];
  return [
    ...blocks.map((block) => ({
      start: block.start,
      end: block.end,
      text: "",
    })),
    {
      start: at,
      end: at,
      text: needsHead ? `<head>${text}</head>\n` : `${text}\n`,
    },
  ];
}

/**
 * Keeps the title stylesheet current in a composition that has titles: written with the first
 * title, replaced when it differs from this version or the fonts in use, and otherwise left byte
 * for byte.
 */
/**
 * Keeps one Cutroom stylesheet block current: rewritten when stale, deduplicated, and added after
 * the stacking block, which must stay first at its location. Unused blocks are left in place.
 */
function managedStyleEdits(
  parsed: ParsedComposition,
  attribute: string,
  style: string | null,
  /** Remove the block once nothing uses it, for a block whose rules follow the clips. */
  removeUnused = false,
): Edit[] {
  if (style === null && !removeUnused) return [];
  const styles = scopeElements(parsed.roots, parsed.scope).filter(
    (element) => element.tag === "style",
  );
  const [block, ...extra] = styles.filter(
    (element) => element.attrs[attribute] !== undefined,
  );
  const removed = extra.map(({ start, end }) => ({ start, end, text: "" }));
  if (style === null)
    return block
      ? [
          {
            start: block.start,
            // With the line break written after it.
            end: block.end + (parsed.html[block.end] === "\n" ? 1 : 0),
            text: "",
          },
          ...removed,
        ]
      : removed;
  if (block)
    return parsed.html.slice(block.start, block.end) === style
      ? removed
      : [{ start: block.start, end: block.end, text: style }, ...removed];
  const stacking = styles.find(
    (element) => element.attrs["data-cutroom-track-stacking"] !== undefined,
  );
  if (stacking)
    return [{ start: stacking.end, end: stacking.end, text: `\n${style}` }];
  const { at, needsHead } = stylesheetLocation(parsed.roots, parsed.scope);
  // A document without a head gets the block beside its root instead of a second implied head.
  const start = needsHead ? parsed.root.start : at;
  return [{ start, end: start, text: `${style}\n` }];
}

/** The authored clip after which a new piece or still is inserted. */
function sourceAnchor(
  origin: ClipOrigin,
  origins: ReadonlyMap<string, ClipOrigin>,
) {
  if ("copyOf" in origin) return origin.copyOf;
  if (!("freeze" in origin)) return;
  const video = origins.get(origin.freeze.clipId);
  return video && "copyOf" in video ? video.copyOf : origin.freeze.clipId;
}

/**
 * Which edges of a dissolve draw under their partner. The clip later in the document is drawn on
 * top and fades; new clips go after every existing one, and a piece right after its source clip.
 */
function dissolveLayers(
  parsed: ParsedComposition,
  after: Timeline,
  origins: ReadonlyMap<string, ClipOrigin>,
) {
  const existing = new Set(parsed.timeline.clips.map((clip) => clip.id));
  const position = (id: string): number => {
    const origin = origins.get(id);
    if (existing.has(id)) return parsed.elements.get(id)!.start;
    const anchor = origin && sourceAnchor(origin, origins);
    return anchor && existing.has(anchor) ? position(anchor) + 0.5 : Infinity;
  };
  const above = (a: Clip, b: Clip) =>
    position(a.id) - position(b.id) || a.start - b.start;
  const under = new Map<string, { in: boolean; out: boolean }>();
  const flag = (id: string, edge: "in" | "out") =>
    under.set(id, { in: false, out: false, ...under.get(id), [edge]: true });
  for (const incoming of after.clips) {
    if (incoming.transitionIn?.kind !== "dissolve") continue;
    const outgoing = after.clips.find(
      (clip) =>
        clip.track === incoming.track &&
        clipEnd(clip) === incoming.start &&
        clip.transitionOut !== null,
    );
    if (!outgoing) continue;
    if (above(incoming, outgoing) > 0) flag(outgoing.id, "out");
    else flag(incoming.id, "in");
  }
  return (id: string) => under.get(id) ?? { in: false, out: false };
}

/** The transition attributes an element needs, as changes from what it has. */
function transitionChanges(
  attrs: SourceElement["attrs"],
  clip: Clip,
  under: { in: boolean; out: boolean },
  fps: Fps,
): AttributeChange[] {
  return [
    ...transitionAttributes("in", clip.transitionIn, under.in, fps),
    ...transitionAttributes("out", clip.transitionOut, under.out, fps),
  ].filter(([name, value]) => (attrs[name] ?? null) !== value);
}

/**
 * Turns an applied timeline into minimal source edits: changed attributes, removed elements, and
 * new clips. Anonymous clips the edit touches or renumbers get their stand-in id written, so the
 * result reads back with the same ids.
 */
export function patchComposition(
  parsed: ParsedComposition,
  after: Timeline,
  origins: ReadonlyMap<string, ClipOrigin>,
  clipboards: ReadonlyMap<string, ParsedComposition> = new Map(),
  /** The compositions new hosts play, by `src`. */
  hosted: ReadonlyMap<string, HostedComposition> = new Map(),
  /** Export-colour stills by their authored preview `src`. */
  freezeExports: ReadonlyMap<string, string> = new Map(),
): string {
  const { html, timeline: before } = parsed;
  const { fps } = before;
  const hostedComposition = (src: string) => {
    const found = hosted.get(src);
    if (!found) throw new Error(`No composition was read for ${src}.`);
    return found;
  };
  const previous = new Map(before.clips.map((clip) => [clip.id, clip]));
  const current = new Map(after.clips.map((clip) => [clip.id, clip]));
  const templates = new Set(
    [...origins.values()].flatMap((origin) =>
      "copyOf" in origin ? [origin.copyOf] : [],
    ),
  );
  const firstRemovedAnonymous = Math.min(
    ...before.clips
      .filter((clip) => parsed.anonymous.has(clip.id) && !current.has(clip.id))
      .map((clip) => parsed.elements.get(clip.id)!.start),
  );
  const spans = new Map(
    scanHtmlOpeningTags(html).map((span) => [span.start, span]),
  );
  const stacking = stackingEdits(parsed, after, previous);
  const mix = trackMix(after.tracks);
  const edits: Edit[] = [
    ...(stacking ?? []),
    ...managedStyleEdits(
      parsed,
      "data-cutroom-titles",
      after.clips.some((clip) => clip.title)
        ? titleStyle(after.clips.flatMap((clip) => clip.title?.font ?? []))
        : null,
    ),
    ...managedStyleEdits(
      parsed,
      TRANSITION_STYLE_ATTRIBUTE,
      after.clips.some((clip) => clip.transitionIn || clip.transitionOut)
        ? transitionStyle()
        : null,
    ),
    ...managedStyleEdits(
      parsed,
      KEYFRAME_STYLE_ATTRIBUTE,
      keyframeStyle(
        after.clips.flatMap(
          (clip) =>
            keyframesAttribute(elementClip(clip, fps).keyframes, fps) ?? [],
        ),
        fps,
      ),
      true,
    ),
  ];
  const regions = regionStyle(after, compositionSize(parsed.root));
  edits.push(
    ...managedStyleEdits(
      parsed,
      REGION_STYLE_ATTRIBUTE,
      regions &&
        `<style ${REGION_STYLE_ATTRIBUTE}="1">\n${regions.css}\n</style>`,
      true,
    ),
  );
  const regionClips = new Set(regions?.clips);
  const under = dissolveLayers(parsed, after, origins);
  const removedIds = new Set<string>();
  for (const clip of before.clips) {
    const element = parsed.elements.get(clip.id)!;
    const next = current.get(clip.id);
    if (next) {
      const changes = [
        ...clipChanges(
          elementClip(clip, fps),
          elementClip(next, fps),
          element,
          fps,
          stacking !== null,
          mix,
        ),
        ...versionChanges(clip, next, element.attrs, hostedComposition),
        ...transitionChanges(element.attrs, next, under(next.id), fps),
      ];
      if (
        parsed.anonymous.has(clip.id) &&
        (changes.length ||
          templates.has(clip.id) ||
          regionClips.has(clip.id) ||
          element.start > firstRemovedAnonymous)
      )
        changes.push(["id", clip.id]);
      if (changes.length)
        edits.push(
          ...attributeEdits(openingTag(spans, element, clip.id), html, changes),
        );
      if (next.text !== null && next.text !== clip.text)
        edits.push(textEdit(parsed, element, next.text));
      continue;
    }
    if (element.attrs.id) removedIds.add(element.attrs.id);
    // Removing an element on its own line also removes the line.
    const lineStart = html.lastIndexOf("\n", element.start - 1);
    const ownLine =
      lineStart >= 0 &&
      /^[\t ]*$/.test(html.slice(lineStart + 1, element.start));
    // An implied end tag leaves trailing whitespace inside the element; it stays in the source.
    edits.push({
      start: ownLine ? lineStart : element.start,
      end: Math.max(
        element.openEnd,
        leadingSpace(html, elementEnd(parsed, element, clip.id)),
      ),
      text: "",
    });
  }

  const inserts = new Map<number, string[]>();
  // New media goes after the last clip in the source, or first in the root.
  const lastClip = [...parsed.elements].reduce<
    [string, SourceElement] | undefined
  >(
    (last, entry) => (!last || entry[1].start > last[1].start ? entry : last),
    undefined,
  );
  for (const clip of after.clips.toSorted(
    (a, b) => a.start - b.start || a.track - b.track,
  )) {
    if (previous.has(clip.id)) continue;
    if (parsed.ids.has(clip.id) && !removedIds.has(clip.id))
      throw new TimelineError(
        "duplicate_id",
        `Another element already has id ${clip.id}.`,
      );
    const origin = origins.get(clip.id);
    if (!origin) throw new Error(`Clip ${clip.id} has no origin.`);
    if ("freeze" in origin) {
      const { clipId } = origin.freeze;
      const videoOrigin = origins.get(clipId);
      const sourceId = sourceAnchor(origin, origins)!;
      const template = parsed.elements.get(sourceId);
      const snapshot =
        videoOrigin && "clipboardId" in videoOrigin
          ? clipboards
              .get(videoOrigin.clipboardId)
              ?.elements.get(videoOrigin.clipId)
          : undefined;
      const last = template ? ([sourceId, template] as const) : lastClip;
      const at = last
        ? elementEnd(parsed, last[1], last[0])
        : parsed.root.openEnd;
      const indent = last ? indentOf(html, last[1].start) : "";
      const attrs = template?.attrs ??
        snapshot?.attrs ?? { style: fittedMedia };
      inserts.set(at, [
        ...(inserts.get(at) ?? []),
        `\n${indent}${insertMarkup(
          elementClip(clip, fps),
          { src: clip.src!, muted: false },
          fps,
          mix,
          transitionChanges({}, clip, under(clip.id), fps),
          attrs,
          freezeExports.get(clip.src!),
        )}`,
      ]);
      continue;
    }
    if ("insert" in origin) {
      const at = lastClip
        ? elementEnd(parsed, lastClip[1], lastClip[0])
        : parsed.root.openEnd;
      const indent = lastClip ? indentOf(html, lastClip[1].start) : "";
      inserts.set(at, [
        ...(inserts.get(at) ?? []),
        `\n${indent}${
          origin.insert.kind === "title"
            ? titleMarkup(clip, fps, mix)
            : origin.insert.kind === "adjustment"
              ? adjustmentMarkup(clip, fps, mix)
              : origin.insert.kind === "composition"
                ? hostMarkup(clip, hostedComposition(clip.src!), fps, mix)
                : insertMarkup(
                    elementClip(clip, fps),
                    origin.insert,
                    fps,
                    mix,
                    transitionChanges({}, clip, under(clip.id), fps),
                    undefined,
                    freezeExports.get(origin.insert.src),
                  )
        }`,
      ]);
      continue;
    }
    if ("clipboardId" in origin) {
      const snapshot = clipboards.get(origin.clipboardId)!;
      const template = snapshot.timeline.clips.find(
        (item) => item.id === origin.clipId,
      )!;
      const at = lastClip
        ? elementEnd(parsed, lastClip[1], lastClip[0])
        : parsed.root.openEnd;
      inserts.set(at, [
        ...(inserts.get(at) ?? []),
        `\n${copyMarkup(snapshot, template, clip, stacking !== null, mix, under(clip.id), hostedComposition)}`,
      ]);
      continue;
    }
    const template = previous.get(origin.copyOf)!;
    const element = parsed.elements.get(template.id)!;
    const at = elementEnd(parsed, element, template.id);
    inserts.set(at, [
      ...(inserts.get(at) ?? []),
      `\n${indentOf(html, element.start)}${copyMarkup(parsed, template, clip, stacking !== null, mix, under(clip.id), hostedComposition)}`,
    ]);
  }
  for (const [at, texts] of inserts)
    edits.push({ start: at, end: at, text: texts.join("") });

  const groupVolumes = new Map(
    after.authoredAudioGroups?.map(({ id, volume }) => [id, volume]),
  );
  const previousGroups = new Set(
    before.authoredAudioGroups?.map(({ id }) => id),
  );
  const addedGroups = (after.authoredAudioGroups ?? []).filter(
    ({ id }) => !previousGroups.has(id),
  );
  const declarations =
    addedGroups.length || previousGroups.size
      ? compositionAudioGroups(parsed.root).filter(
          (element) => !isManagedAudioGroup(element),
        )
      : [];
  if (addedGroups.length) {
    const last = declarations.at(-1);
    const at = last ? last.end : parsed.root.openEnd;
    const indent = last
      ? indentOf(html, last.start)
      : indentOf(html, parsed.root.start) + "  ";
    const tags = addedGroups.map(({ id, label, volume }) => {
      if (parsed.ids.has(id))
        throw new TimelineError(
          "duplicate_id",
          `Audio group ID ${id} is already in use.`,
        );
      const name = label ? ` data-label="${escapeAttribute(label)}"` : "";
      return `\n${indent}<hf-audio-group id="${escapeAttribute(id)}"${name} ${ROUTED_AUDIO_GROUP} data-volume="${volume}"></hf-audio-group>`;
    });
    edits.push({
      start: at,
      end: at,
      text: tags.join("") + "\n",
    });
  }
  const changedGroups = new Map(
    before.authoredAudioGroups?.flatMap(({ id, volume, sourceRestriction }) => {
      const next = groupVolumes.get(id);
      return !sourceRestriction && next !== undefined && volume !== next
        ? [[id, next] as const]
        : [];
    }),
  );
  if (changedGroups.size) {
    for (const element of declarations) {
      const id = element.attrs.id;
      if (!id) continue;
      const volume = changedGroups.get(id);
      if (volume === undefined) continue;
      edits.push(
        ...attributeEdits(openingTag(spans, element, id), html, [
          ["data-volume", String(volume)],
        ]),
      );
    }
  }

  const rootChanges: AttributeChange[] = [
    ...(parsed.rootDurationAuthored && after.duration !== before.duration
      ? [["data-duration", String(toSeconds(after.duration, fps))] as const]
      : []),
    ...(!Bun.deepEquals(before.masterFx ?? [], after.masterFx ?? [])
      ? [
          [
            "data-fx-chain",
            writeFxChain(
              after.masterFx ?? [],
              parsed.root.attrs["data-fx-chain"],
            ),
          ] as const,
        ]
      : []),
  ];
  if (rootChanges.length)
    edits.push(
      ...attributeEdits(
        openingTag(spans, parsed.root, "root"),
        html,
        rootChanges,
      ),
    );
  const output = applyEdits(html, edits);
  // Unity buses are projected for playback; persist routing only once a track fader is used.
  if (
    !after.tracks.some((track) => track.volume !== 1 || track.fx.length) &&
    !managedAudioGroups(parsed.root).length
  )
    return output;
  return applyTrackMix(
    parseComposition(output, settingsOf(after), {
      scope: parsed.scope,
      fonts: parsed.fonts,
      mediaLengths: new Map(
        after.clips.flatMap((clip) =>
          clip.src && clip.sourceDuration
            ? [[clip.src, clip.sourceDuration] as const]
            : [],
        ),
      ),
    }),
  );
}

/** A copied element keeps its media paths when pasted into another composition folder. */
export function rebaseClipboard(
  parsed: ParsedComposition,
  from: string,
  to: string,
): ParsedComposition {
  if (posix.dirname(from) === posix.dirname(to)) return parsed;
  const rewrite = (src: string) => {
    if (src.startsWith("#")) return src;
    const path = localMediaPath(from, src);
    if (path === null) return src;
    const suffix = src.slice(
      src.search(/[?#]/) < 0 ? src.length : src.search(/[?#]/),
    );
    return (
      posix
        .relative(posix.dirname(to), path)
        .split("/")
        .map(encodeURIComponent)
        .join("/") + suffix
    );
  };
  const spans = new Map(
    scanHtmlOpeningTags(parsed.html).map((span) => [span.start, span]),
  );
  const edits: Edit[] = [];
  for (const element of descendants(parsed.roots, true)) {
    const changes: AttributeChange[] = [];
    for (const [name, value] of Object.entries(element.attrs)) {
      const next = [
        "src",
        "poster",
        "href",
        "data-composition-src",
        freezeExportSource,
      ].includes(name)
        ? rewrite(value)
        : name === "srcset"
          ? rewriteSrcsetUrls(value, rewrite)
          : name === "style"
            ? value.replace(
                CSS_URL_RE,
                (_, quote: string, url: string) =>
                  `url(${quote}${rewrite(url)}${quote})`,
              )
            : name === VERSIONS_ATTRIBUTE
              ? rebaseVersions(value, rewrite)
              : value;
      if (next !== value) changes.push([name, next]);
    }
    if (changes.length)
      edits.push(
        ...attributeEdits(
          openingTag(spans, element, "clipboard"),
          parsed.html,
          changes,
        ),
      );
  }
  const rebased = parseComposition(
    applyEdits(parsed.html, edits),
    settingsOf(parsed.timeline),
    {
      scope: parsed.scope,
      fonts: parsed.fonts,
      mediaLengths: new Map(
        parsed.timeline.clips.flatMap((clip) =>
          clip.src !== null && clip.sourceDuration !== null
            ? [[rewrite(clip.src), clip.sourceDuration] as const]
            : [],
        ),
      ),
    },
  );
  return rebased;
}
