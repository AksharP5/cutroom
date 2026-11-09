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

function mediaElement(document: Document, elementId: string): Element | null {
  const selected = findTargetElement(document, { id: elementId });
  if (selected) return selected;
  const index = /^media:(\d+)$/.exec(elementId)?.[1];
  return index === undefined
    ? null
    : (document.querySelectorAll("video, audio").item(Number(index)) ?? null);
}

export function transcriptStart(
  source: string,
  transcript: Transcript,
): number {
  const { document } = parseSourceDocument(source);
  const group = [
    ...document.querySelectorAll("[data-cutroom-transcript]"),
  ].filter(
    (element) =>
      element.getAttribute("data-cutroom-transcript") === transcript.id,
  );
  if (group.length)
    return Math.min(
      ...group.map((element) => Number(element.getAttribute("data-start"))),
    );
  const anchor = [
    ...document.querySelectorAll("template[data-cutroom-anchor]"),
  ].find(
    (element) => element.getAttribute("data-cutroom-anchor") === transcript.id,
  );
  if (anchor)
    return Number(
      anchor.getAttribute("data-cutroom-start") ?? transcript.original.start,
    );
  const media = mediaElement(document, transcript.elementId);
  if (!media)
    throw new HttpError(
      409,
      "The transcript's media clip is no longer in this composition.",
    );
  return Number(media.getAttribute("data-start") ?? 0);
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

export function transcriptView(transcript: Transcript) {
  const kept = keptRanges(transcript);
  const cutIds = new Set(transcript.cutWordIds);
  const rate = transcript.original.playbackRate;
  let rangeIndex = 0;
  let before = 0;
  const words = transcript.words.map((word) => {
    while (rangeIndex < kept.length && word.start >= kept[rangeIndex]!.end) {
      const range = kept[rangeIndex++]!;
      before += range.end - range.start;
    }
    let timelineStart: number | null = null;
    const range = kept[rangeIndex];
    if (range && word.start >= range.start - 0.001 && word.start < range.end)
      timelineStart = round(
        transcript.original.start + (before + word.start - range.start) / rate,
      );
    return { ...word, cut: cutIds.has(word.id), timelineStart };
  });
  return {
    ...transcript,
    words,
    duration: round(
      kept.reduce((sum, range) => sum + range.end - range.start, 0) / rate,
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
  let ancestor = media.parentElement;
  while (ancestor && ancestor !== document.body) {
    if (
      ancestor.hasAttribute("data-start") &&
      !ancestor.hasAttribute("data-composition-id")
    ) {
      throw new HttpError(
        422,
        "This media belongs to a nested timed scene. Ask the agent to edit its script with the surrounding scene.",
      );
    }
    ancestor = ancestor.parentElement;
  }
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
  const link = media.getAttribute("data-link");
  if (
    link &&
    [...document.querySelectorAll("[data-link]")].some(
      (element) =>
        element !== media && element.getAttribute("data-link") === link,
    )
  ) {
    throw new HttpError(
      422,
      "This clip has linked media. Ask the agent to cut the linked clips together.",
    );
  }
  if (
    [...document.querySelectorAll("script")].some((script) =>
      script.textContent?.includes(`#${elementId}`),
    )
  ) {
    throw new HttpError(
      422,
      "This media has scripted animation. Ask the agent to preserve its animation while cutting.",
    );
  }
  return { html: media.outerHTML, start, duration, mediaStart, playbackRate };
}

/** Script cuts ripple the selected media lane. Other tracks retain their authored timing. */
export function applyTranscriptCuts(
  source: string,
  transcript: Transcript,
  cutWordIds: string[],
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
  if (
    templateMedia?.getAttribute("src") !== originalMedia?.getAttribute("src") ||
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
  const expectedDuration = keptRanges(transcript).reduce(
    (sum, range) =>
      sum + (range.end - range.start) / transcript.original.playbackRate,
    0,
  );
  if (Math.abs(oldDuration - expectedDuration) > 0.001)
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
      element.getAttribute("data-track-index") !== track ||
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
      `${transcript.elementId}-cut-${index + 1}`,
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
