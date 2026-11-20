import { parse } from "parse5";
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
export type CaptureWorkload = {
  mediaClips: number;
  durationFrames: number;
  fps?: Fps;
  /** Element intervals in composition seconds, including any transition handles. */
  timedMedia?: Range[];
};

/**
 * The span renderer defers video loads until a chunk shows them. Only count
 * media by time when the document can establish every media element's timing.
 */
export function timedCaptureMedia(html: string): Range[] | undefined {
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
