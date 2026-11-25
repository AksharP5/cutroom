import {
  parseStartExpression,
  scanHtmlOpeningTags,
} from "@hyperframes/parsers";
import { defaultTreeAdapter, parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { Fps } from "../../shared/timeline/schema.ts";
import type { ExportOptions } from "../../shared/export.ts";
import { frameTime } from "../../shared/timeline/time.ts";
import {
  activeContent,
  attribute,
  elements,
  LIBRARY_SCRIPTS,
  seconds,
} from "./directPlan.ts";

type Range = NonNullable<ExportOptions["range"]>;
type Element = DefaultTreeAdapterTypes.Element;
const IDLE_SOURCE = "data-cutroom-idle-src";
export type CaptureWorkload = {
  mediaClips: number;
  durationFrames: number;
  fps?: Fps;
  /** Element intervals in composition seconds, including any transition handles. */
  timedMedia?: Range[];
};

/**
 * The media elements a capture browser loads: every video, and every sound unless the export
 * mixes sound itself and the browser is refused it, as a marked export's is. Disabled clips
 * load nothing.
 */
export function loadedMedia(html: string, sound: boolean) {
  const kinds = sound ? ["video", "audio"] : ["video"];
  let count = 0;
  const visit = (node: Element) => {
    if (attribute(node, "data-hidden") !== undefined) return;
    if (
      kinds.includes(node.tagName) &&
      (attribute(node, IDLE_SOURCE) === undefined ||
        attribute(node, "src") !== undefined)
    )
      count++;
    for (const child of elements(node)) visit(child);
  };
  for (const node of elements(parse(html))) visit(node);
  return count;
}

/**
 * The span renderer defers video loads until a chunk shows them. Only count
 * media by time when the document can establish every media element's timing.
 */
export function timedCaptureMedia(
  html: string,
  sound = true,
): Range[] | undefined {
  const page = elements(parse(html)).find(({ tagName }) => tagName === "html");
  const head = page && elements(page).find(({ tagName }) => tagName === "head");
  const body = page && elements(page).find(({ tagName }) => tagName === "body");
  if (!page || !head || !body || elements(body).length !== 1) return;
  const root = elements(body)[0]!;
  if (
    attribute(root, "data-composition-id") === undefined ||
    activeContent(root) ||
    [page, head, body, root].some(({ attrs }) =>
      attrs.some(({ name }) => /^on/i.test(name)),
    ) ||
    elements(head).some(
      (element) =>
        !["meta", "style", "title"].includes(element.tagName) &&
        !(
          element.tagName === "script" &&
          element.attrs.length === 1 &&
          element.childNodes.length === 0 &&
          LIBRARY_SCRIPTS.has(attribute(element, "src") ?? "")
        ),
    )
  )
    return;
  const spans: Range[] = [];
  for (const element of elements(root)) {
    if (
      attribute(element, "data-composition-id") !== undefined ||
      attribute(element, "data-composition-src") !== undefined ||
      element.tagName === "template" ||
      elements(element).length
    )
      return;
    if (element.tagName !== "video" && element.tagName !== "audio") continue;
    if (!sound && element.tagName === "audio") continue;
    if (
      attribute(element, IDLE_SOURCE) !== undefined &&
      attribute(element, "src") === undefined
    )
      continue;
    const start = seconds(attribute(element, "data-start"));
    const length = seconds(attribute(element, "data-duration"));
    if (
      start === null ||
      length === null ||
      length <= 0 ||
      attribute(element, "autoplay") !== undefined
    )
      return;
    spans.push({ start, end: start + length });
  }
  return spans;
}

/**
 * Keep the authored DOM in place. Detach only a video source that none of the
 * capture frames or exported sound need. Stills keep their intrinsic layout.
 */
export function captureDocument(
  html: string,
  runs: readonly Range[],
  fps: Fps,
) {
  const page = elements(parse(html, { sourceCodeLocationInfo: true })).find(
    ({ tagName }) => tagName === "html",
  );
  const head = page && elements(page).find(({ tagName }) => tagName === "head");
  const body = page && elements(page).find(({ tagName }) => tagName === "body");
  const root = body && elements(body)[0];
  if (
    !page ||
    !head ||
    !body ||
    !root ||
    elements(body).length !== 1 ||
    attribute(root, "data-composition-id") === undefined ||
    activeContent(root) ||
    [page, head, body, root].some(({ attrs }) =>
      attrs.some(({ name }) => /^on/i.test(name)),
    )
  )
    return html;
  for (const element of elements(head)) {
    if (element.tagName === "meta" || element.tagName === "title") continue;
    if (element.tagName === "style") {
      const css = element.childNodes
        .filter(defaultTreeAdapter.isTextNode)
        .map(({ value }) => value)
        .join("");
      // A stylesheet can observe the source attribute or override a timed clip's visibility.
      if (
        !/\\|@import|\[\s*(?:[\w*-]*\|\s*)?(?:src|data-cutroom-idle-src)\b|(?:display|visibility|opacity)\s*:[^;}]+!\s*important/i.test(
          css,
        )
      )
        continue;
    }
    if (
      element.tagName === "script" &&
      element.attrs.length === 1 &&
      element.childNodes.length === 0 &&
      LIBRARY_SCRIPTS.has(attribute(element, "src") ?? "")
    )
      continue;
    return html;
  }
  const clips = elements(root);
  const reach = Math.max(
    0,
    ...clips.flatMap(({ attrs }) =>
      attrs.flatMap(({ name, value }) =>
        /^data-transition-(in|out)-duration$/.test(name)
          ? [seconds(value) ?? Infinity]
          : [],
      ),
    ),
  );
  // One frame either side covers rounded timings.
  const shown = runs.map(({ start, end }) => ({
    start: frameTime(start - 1, fps) - reach,
    end: frameTime(end + 1, fps) + reach,
  }));
  // An off-range clip can still set the start of a clip in range.
  const anchors = new Set<string>();
  for (const { attributes } of scanHtmlOpeningTags(html)) {
    const start = attributes.find(({ name }) => name === "data-start");
    if (start?.kind !== "value") continue;
    const expression = parseStartExpression(start.value);
    if (expression?.kind === "reference") anchors.add(expression.refId);
  }
  const idle: number[] = [];
  for (const clip of clips) {
    if (clip.tagName !== "video" || elements(clip).length) continue;
    if (anchors.has(attribute(clip, "id") ?? "")) continue;
    if (
      clip.attrs.some(({ name }) =>
        ["autoplay", "poster", "data-var-src", IDLE_SOURCE].includes(name),
      )
    )
      continue;
    const start = seconds(attribute(clip, "data-start"));
    const length = seconds(attribute(clip, "data-duration"));
    if (start === null || length === null || length <= 0) continue;
    if (shown.some((run) => start < run.end && run.start < start + length))
      continue;
    if (
      attribute(clip, "muted") === undefined &&
      attribute(clip, "data-has-audio") !== "false"
    )
      continue;
    // An intrinsic size change could otherwise move its siblings even while hidden.
    if (
      !attribute(clip, "style")?.startsWith(
        "position:absolute;inset:0;width:100%;height:100%;",
      )
    )
      continue;
    const source = clip.sourceCodeLocation?.attrs?.src;
    if (source) idle.push(source.startOffset);
  }
  let kept = html;
  for (const offset of idle.sort((a, b) => b - a)) {
    kept =
      kept.slice(0, offset) + IDLE_SOURCE + kept.slice(offset + "src".length);
  }
  return kept;
}

export function countCaptureMedia(
  workload: CaptureWorkload,
  fps: Fps,
  ranges: readonly Range[] | undefined,
) {
  if (!ranges || !workload.timedMedia) return workload.mediaClips;
  // Include the adjacent frame at a cut for capture initialization and rounded HTML timings.
  const times = ranges.map(({ start, end }) => ({
    start: frameTime(start - 1, fps),
    end: frameTime(end + 1, fps),
  }));
  return workload.timedMedia.filter((media) =>
    times.some(({ start, end }) => media.start < end && start < media.end),
  ).length;
}
