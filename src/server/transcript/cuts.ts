import {
  findTargetElement,
  parseSourceDocument,
  splitElementInHtml,
} from "@hyperframes/studio-server";
import type { Transcript, TranscriptWord } from "../../shared/project";
import { HttpError } from "../../shared/errors";

interface Range {
  start: number;
  end: number;
}
const round = (number: number) => Math.round(number * 1_000_000) / 1_000_000;

export function mediaElement(
  document: Document,
  elementId: string,
): Element | null {
  const selected = findTargetElement(document, { id: elementId });
  if (selected) return selected;
  const index = /^media:(\d+)$/.exec(elementId)?.[1];
  return index === undefined
    ? null
    : (document.querySelectorAll("video, audio").item(Number(index)) ?? null);
}

function requireEditableMedia(
  document: Document,
  elements: Element[],
  elementIds: string[],
) {
  if (elements.some(nestedTiming))
    throw new HttpError(
      422,
      "This media belongs to a nested timed scene. Ask the agent to edit its script with the surrounding scene.",
    );
  const linked = [...document.querySelectorAll("[data-link]")];
  if (
    elements.some((media) => {
      const link = media.getAttribute("data-link");
      return (
        link &&
        linked.some(
          (element) =>
            !elements.includes(element) &&
            element.getAttribute("data-link") === link,
        )
      );
    })
  )
    throw new HttpError(
      422,
      "This clip has linked media. Ask the agent to cut the linked clips together.",
    );
  if (
    [...document.querySelectorAll("script")].some((script) =>
      elementIds.some((id) => id && script.textContent?.includes(`#${id}`)),
    )
  )
    throw new HttpError(
      422,
      "This media has scripted animation. Ask the agent to preserve its animation while cutting.",
    );
}

function nestedTiming(element: Element): boolean {
  const root = element.ownerDocument.querySelector("[data-composition-id]");
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== element.ownerDocument.body) {
    if (ancestor !== root && ancestor.hasAttribute("data-start")) return true;
    ancestor = ancestor.parentElement;
  }
  return false;
}

export function transcriptStart(
  document: Document,
  transcript: Transcript,
): number {
  const group = [
    ...document.querySelectorAll("[data-cutroom-transcript]"),
  ].filter(
    (element) =>
      element.getAttribute("data-cutroom-transcript") === transcript.id,
  );
  let start: number;
  const anchor = [
    ...document.querySelectorAll("template[data-cutroom-anchor]"),
  ].find(
    (element) => element.getAttribute("data-cutroom-anchor") === transcript.id,
  );
  if (group.length)
    start = Math.min(
      ...group.map((element) => Number(element.getAttribute("data-start"))),
    );
  else if (anchor)
    start = Number(
      anchor.getAttribute("data-cutroom-start") ?? transcript.original.start,
    );
  else {
    const media = mediaElement(document, transcript.elementId);
    if (!media)
      throw new HttpError(
        409,
        "The transcript's media clip is no longer in this composition.",
      );
    start = Number(media.getAttribute("data-start") ?? 0);
  }
  if (!Number.isFinite(start) || start < 0)
    throw new HttpError(
      409,
      "The transcript's clip has invalid timeline timing. Correct it before editing the script.",
    );
  return start;
}

export function cutRanges(
  words: TranscriptWord[],
  cutWordIds: readonly string[],
): Range[] {
  const selected = new Set(cutWordIds);
  const ordered = [...words].sort((a, b) => a.start - b.start);
  const runs: Range[] = [];
  let previousSelected = false;
  for (const word of ordered) {
    if (!selected.has(word.id)) {
      previousSelected = false;
      continue;
    }
    const previous = runs.at(-1);
    if (previousSelected && previous)
      previous.end = Math.max(previous.end, word.end);
    else runs.push({ start: word.start, end: word.end });
    previousSelected = true;
  }
  const merged: Range[] = [];
  for (const range of runs) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 0.001)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function keptRanges(
  transcript: Transcript,
  cutWordIds = transcript.cutWordIds,
): Range[] {
  const original = transcript.original;
  const end = original.mediaStart + original.duration * original.playbackRate;
  let cursor = original.mediaStart;
  const kept: Range[] = [];
  for (const cut of cutRanges(transcript.words, cutWordIds)) {
    const start = Math.max(original.mediaStart, Math.min(end, cut.start));
    const cutEnd = Math.max(start, Math.min(end, cut.end));
    if (start > cursor + 0.000001) kept.push({ start: cursor, end: start });
    cursor = Math.max(cursor, cutEnd);
  }
  if (cursor < end - 0.000001) kept.push({ start: cursor, end });
  return kept;
}

export function transcriptView(transcript: Transcript, document?: Document) {
  const start = document
    ? transcriptStart(document, transcript)
    : transcript.original.start;
  const elements = document
    ? [...document.querySelectorAll("[data-cutroom-transcript]")].filter(
        (element) =>
          element.getAttribute("data-cutroom-transcript") === transcript.id,
      )
    : [];
  const anchor =
    document &&
    [...document.querySelectorAll("template[data-cutroom-anchor]")].some(
      (element) =>
        element.getAttribute("data-cutroom-anchor") === transcript.id,
    );
  if (document && !elements.length && !anchor) {
    const media = mediaElement(document, transcript.elementId);
    if (media) elements.push(media);
  }
  let cursor = transcript.original.start;
  const ranges = document
    ? elements
        .map((element) => {
          const timelineStart = Number(
            element.getAttribute("data-start") ?? "0",
          );
          const duration = Number(element.getAttribute("data-duration"));
          const mediaStart = Number(
            element.getAttribute("data-media-start") ??
              element.getAttribute("data-playback-start") ??
              "0",
          );
          const rate = Number(
            element.getAttribute("data-playback-rate") ?? "1",
          );
          if (
            ![timelineStart, duration, mediaStart, rate].every(
              Number.isFinite,
            ) ||
            timelineStart < 0 ||
            duration <= 0 ||
            mediaStart < 0 ||
            rate <= 0
          )
            throw new HttpError(
              409,
              "The transcript's clip has invalid media timing. Correct it before seeking its words.",
            );
          return {
            start: mediaStart,
            end: mediaStart + duration * rate,
            timelineStart,
            rate,
          };
        })
        .sort((a, b) => a.start - b.start)
    : keptRanges(transcript).map((range) => {
        const timelineStart = cursor;
        cursor += (range.end - range.start) / transcript.original.playbackRate;
        return {
          ...range,
          timelineStart,
          rate: transcript.original.playbackRate,
        };
      });
  const cutIds = new Set(transcript.cutWordIds);
  let rangeIndex = 0;
  const words = transcript.words.map((word) => {
    while (rangeIndex < ranges.length && word.start >= ranges[rangeIndex]!.end)
      rangeIndex++;
    let timelineStart: number | null = null;
    const range = ranges[rangeIndex];
    if (range && word.start >= range.start - 0.001 && word.start < range.end)
      timelineStart = round(
        range.timelineStart + (word.start - range.start) / range.rate,
      );
    return { ...word, cut: cutIds.has(word.id), timelineStart };
  });
  return {
    ...transcript,
    original: { ...transcript.original, start },
    words,
    duration: round(
      ranges.reduce(
        (sum, range) => sum + (range.end - range.start) / range.rate,
        0,
      ),
    ),
  };
}

export function originalClip(source: string, elementId: string) {
  const { document } = parseSourceDocument(source);
  const media = mediaElement(document, elementId);
  if (!media || !["VIDEO", "AUDIO"].includes(media.tagName.toUpperCase()))
    throw new HttpError(
      422,
      "Choose the video or audio element to edit its script.",
    );
  requireEditableMedia(document, [media], [elementId, media.id]);
  const start = Number(media.getAttribute("data-start") ?? "0");
  const duration = Number(media.getAttribute("data-duration"));
  const mediaStart = Number(
    media.getAttribute("data-media-start") ??
      media.getAttribute("data-playback-start") ??
      "0",
  );
  const playbackRate = Number(media.getAttribute("data-playback-rate") ?? "1");
  if (
    ![start, duration, mediaStart, playbackRate].every(Number.isFinite) ||
    start < 0 ||
    duration <= 0 ||
    mediaStart < 0 ||
    playbackRate <= 0
  ) {
    throw new HttpError(
      422,
      "Script editing needs a media clip with numeric start, duration, and playback rate.",
    );
  }
  return { html: media.outerHTML, start, duration, mediaStart, playbackRate };
}

/** Script cuts ripple the selected media lane. Other tracks retain their authored timing. */
export function applyTranscriptCuts(
  source: string,
  transcript: Transcript,
  cutWordIds: string[],
  /** Names a new piece from a base such as `talk-cut`; the piece ids keep `-cut-`. */
  newId: (base: string) => string,
): string {
  const { document } = parseSourceDocument(source);
  const group = [
    ...document.querySelectorAll("[data-cutroom-transcript]"),
  ].filter(
    (element) =>
      element.getAttribute("data-cutroom-transcript") === transcript.id,
  );
  let anchor = [
    ...document.querySelectorAll("template[data-cutroom-anchor]"),
  ].find(
    (element) => element.getAttribute("data-cutroom-anchor") === transcript.id,
  );
  const originalElement = anchor
    ? findTargetElement(document, { id: transcript.elementId })
    : mediaElement(document, transcript.elementId);
  if (group.length === 0 && !anchor && originalElement)
    group.push(originalElement);
  requireEditableMedia(
    document,
    group.length ? group : anchor ? [anchor] : [],
    [transcript.elementId, ...group.map((element) => element.id)],
  );
  const fingerprint = (element: Element) => {
    const clone = element.cloneNode(true);
    if (clone.nodeType !== 1) return "";
    const container = document.createElement("div");
    container.appendChild(clone);
    for (const node of container.querySelectorAll("*")) {
      for (const name of [
        "id",
        "data-hf-id",
        "data-start",
        "data-duration",
        "data-end",
        "data-media-start",
        "data-playback-start",
        "data-cutroom-transcript",
      ])
        node.removeAttribute(name);
    }
    return container.innerHTML;
  };
  const firstFingerprint = group[0] && fingerprint(group[0]);
  if (group.some((element) => fingerprint(element) !== firstFingerprint))
    throw new HttpError(
      409,
      "A split segment has independent edits. Ask the agent to preserve those edits while changing the script.",
    );
  if (!anchor) {
    if (!originalElement?.parentNode)
      throw new HttpError(
        409,
        "The media clip moved or was removed. Reimport its transcript before cutting.",
      );
    anchor = document.createElement("template");
    anchor.setAttribute("data-cutroom-anchor", transcript.id);
    originalElement.parentNode.insertBefore(anchor, originalElement);
  }
  const currentTemplate = group[0]?.outerHTML ?? transcript.original.html;
  const templateMedia =
    parseSourceDocument(currentTemplate).document.querySelector("video, audio");
  const originalMedia = parseSourceDocument(
    transcript.original.html,
  ).document.querySelector("video, audio");
  const mediaSource = (element: Element | null) =>
    element?.getAttribute("src") ??
    element?.querySelector("source")?.getAttribute("src");
  if (
    mediaSource(templateMedia) !== mediaSource(originalMedia) ||
    Number(templateMedia?.getAttribute("data-playback-rate") ?? "1") !==
      transcript.original.playbackRate
  ) {
    throw new HttpError(
      409,
      "The clip's source or playback rate changed. Revert that edit before changing its script cuts.",
    );
  }
  const currentStart = group.length
    ? Math.min(
        ...group.map((element) =>
          Number(
            element.getAttribute("data-start") ?? transcript.original.start,
          ),
        ),
      )
    : Number(
        anchor.getAttribute("data-cutroom-start") ?? transcript.original.start,
      );
  const oldDuration = group.reduce(
    (sum, element) => sum + Number(element.getAttribute("data-duration") ?? 0),
    0,
  );
  const priorRanges = keptRanges(transcript);
  let expectedStart = currentStart;
  const ordered = [...group].sort(
    (a, b) =>
      Number(
        a.getAttribute("data-media-start") ??
          a.getAttribute("data-playback-start") ??
          "0",
      ) -
      Number(
        b.getAttribute("data-media-start") ??
          b.getAttribute("data-playback-start") ??
          "0",
      ),
  );
  const timingMatches = ordered.every((element, index) => {
    const range = priorRanges[index];
    if (!range) return false;
    const start = Number(element.getAttribute("data-start") ?? "0");
    const duration = Number(element.getAttribute("data-duration"));
    const mediaStart = Number(
      element.getAttribute("data-media-start") ??
        element.getAttribute("data-playback-start") ??
        "0",
    );
    const expectedDuration =
      (range.end - range.start) / transcript.original.playbackRate;
    const matches =
      [start, duration, mediaStart].every(Number.isFinite) &&
      Math.abs(start - expectedStart) <= 0.001 &&
      Math.abs(duration - expectedDuration) <= 0.001 &&
      Math.abs(mediaStart - range.start) <= 0.001;
    expectedStart += expectedDuration;
    return matches;
  });
  if (!timingMatches || ordered.length !== priorRanges.length)
    throw new HttpError(
      409,
      "This clip's timing changed outside Script. Undo that timing edit before changing its script cuts.",
    );
  const track =
    group[0]?.getAttribute("data-track-index") ??
    anchor.getAttribute("data-cutroom-track") ??
    originalMedia?.getAttribute("data-track-index") ??
    "0";
  anchor.setAttribute("data-cutroom-start", String(currentStart));
  anchor.setAttribute("data-cutroom-track", track);
  const kept = keptRanges(transcript, cutWordIds);
  const newDuration = kept.reduce(
    (sum, range) =>
      sum + (range.end - range.start) / transcript.original.playbackRate,
    0,
  );
  const delta = round(newDuration - oldDuration);
  const oldEnd = round(currentStart + oldDuration);
  const maxEnd = (doc: Document) =>
    Math.max(
      0,
      ...[...doc.querySelectorAll("[data-start][data-duration]")]
        .filter((element) => !element.hasAttribute("data-composition-id"))
        .filter((element) => !nestedTiming(element))
        .map(
          (element) =>
            Number(element.getAttribute("data-start")) +
            Number(element.getAttribute("data-duration")),
        )
        .filter(Number.isFinite),
    );
  const beforeMax = maxEnd(document);
  const rootDuration = Number(
    document
      .querySelector("[data-composition-id]")
      ?.getAttribute("data-duration") ?? "0",
  );
  const tail =
    oldDuration === 0 && beforeMax === 0 && rootDuration === 0.001
      ? 0
      : Math.max(0, rootDuration - beforeMax);
  for (const element of document.querySelectorAll(
    "[data-start][data-duration]",
  )) {
    if (
      group.includes(element) ||
      (element.getAttribute("data-track-index") ?? "0") !== track ||
      nestedTiming(element) ||
      element.hasAttribute("data-composition-id")
    )
      continue;
    const start = Number(element.getAttribute("data-start"));
    if (Number.isFinite(start) && start >= oldEnd - 0.000001)
      element.setAttribute("data-start", String(round(start + delta)));
  }
  for (const element of group) element.remove();
  const parsedTemplate = parseSourceDocument(currentTemplate).document;
  const media = parsedTemplate.querySelector("video, audio");
  if (!media || !anchor.parentNode)
    throw new HttpError(409, "The original media clip cannot be restored.");
  const imported = document.importNode(media, true);
  imported.setAttribute("id", transcript.elementId);
  imported.setAttribute("data-cutroom-transcript", transcript.id);
  imported.setAttribute("data-start", String(currentStart));
  imported.setAttribute("data-duration", String(transcript.original.duration));
  imported.setAttribute(
    "data-media-start",
    String(transcript.original.mediaStart),
  );
  imported.removeAttribute("data-playback-start");
  anchor.parentNode.insertBefore(imported, anchor.nextSibling);
  let html = `${source.trimStart().toLowerCase().startsWith("<!doctype") ? "<!doctype html>\n" : ""}${document.documentElement.outerHTML}`;
  const sourceEnd =
    transcript.original.mediaStart +
    transcript.original.duration * transcript.original.playbackRate;
  const boundaries = [
    ...new Set(kept.flatMap((range) => [range.start, range.end])),
  ]
    .filter(
      (time) =>
        time > transcript.original.mediaStart + 0.001 &&
        time < sourceEnd - 0.001,
    )
    .sort((a, b) => a - b);
  let rightId = transcript.elementId;
  for (let index = 0; index < boundaries.length; index++) {
    const time =
      currentStart +
      (boundaries[index]! - transcript.original.mediaStart) /
        transcript.original.playbackRate;
    const split = splitElementInHtml(
      html,
      { id: rightId },
      time,
      newId(`${transcript.elementId}-cut`),
    );
    if (!split.matched || !split.newId)
      throw new HttpError(
        422,
        "Could not split this media clip at a word boundary.",
      );
    html = split.html;
    rightId = split.newId;
  }
  const finalDocument = parseSourceDocument(html).document;
  const pieces = [
    ...finalDocument.querySelectorAll("[data-cutroom-transcript]"),
  ]
    .filter(
      (element) =>
        element.getAttribute("data-cutroom-transcript") === transcript.id,
    )
    .sort(
      (a, b) =>
        Number(a.getAttribute("data-media-start")) -
        Number(b.getAttribute("data-media-start")),
    );
  let cursor = currentStart;
  let keptIndex = 0;
  for (const piece of pieces) {
    const mediaStart = Number(piece.getAttribute("data-media-start"));
    const duration = Number(piece.getAttribute("data-duration"));
    const end = mediaStart + duration * transcript.original.playbackRate;
    while (
      keptIndex < kept.length &&
      mediaStart >= kept[keptIndex]!.end - 0.001
    )
      keptIndex++;
    const range = kept[keptIndex];
    if (!range || mediaStart < range.start - 0.001 || end > range.end + 0.001) {
      piece.remove();
      continue;
    }
    piece.setAttribute("data-start", String(round(cursor)));
    piece.setAttribute("data-duration", String(round(duration)));
    cursor += duration;
  }
  const root = finalDocument.querySelector("[data-composition-id]");
  if (root && Number.isFinite(rootDuration))
    root.setAttribute(
      "data-duration",
      String(Math.max(0.001, round(maxEnd(finalDocument) + tail))),
    );
  return finalDocument.toString();
}
