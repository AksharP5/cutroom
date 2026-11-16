import { parseFpsWithDefault } from "@hyperframes/core";
import { parseSourceDocument } from "@hyperframes/studio-server";
import type { FileMutationInput } from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import { captionText } from "../../shared/captions";
import type {
  CaptionStyle,
  Captions,
  CaptionsView,
} from "../../shared/captions";
import type { Project, Transcript, TranscriptView } from "../../shared/project";
import { localMediaPath } from "../../shared/media";
import {
  canonicalSeconds,
  toFrames,
  toSeconds,
} from "../../shared/timeline/apply";
import type { Fps } from "../../shared/timeline/schema";
import { readSource } from "../projects/store";
import { projectWritePath } from "../projects/path";
import { setElementAttributes } from "../timeline/composition";
import { transcriptView } from "../transcript/cuts";
import { groupWords, readCaptions, renderCaptions } from "./captions";
import type { CaptionsFrame } from "./captions";

/** The track kind HyperFrames Studio and lint read on a captions host. */
export const CAPTIONS_TRACK_KIND = "captions";

/** Less of a word than this on the timeline is not heard, so it is not captioned. */
const SLIVER = 0.05;

/** A captions clip in a composition and the file it plays. */
export interface PlacedCaptions {
  clipId: string;
  /** Seconds, as the host writes them. */
  start: number;
  duration: number;
  /** Seconds into the captions the clip starts, after a head trim. */
  offset: number;
  file: string;
  version: string;
  captions: Captions;
  frame: CaptionsFrame;
}

/**
 * The captions clips in a composition: hosts marked as a captions track whose file Cutroom wrote.
 * Other scenes and files that cannot be read as captions are not captions.
 */
export async function placedCaptions(
  project: Project,
  sourceFile: string,
  html: string,
): Promise<PlacedCaptions[]> {
  const { document } = parseSourceDocument(html);
  const hosts = [
    ...document.querySelectorAll(
      `[data-track-kind="${CAPTIONS_TRACK_KIND}"][data-composition-src]`,
    ),
  ];
  const placed: PlacedCaptions[] = [];
  for (const host of hosts) {
    const file = localMediaPath(
      sourceFile,
      host.getAttribute("data-composition-src")!,
    );
    if (!file || file.startsWith("../") || !host.id) continue;
    const source = await readSource(project, file).catch(() => null);
    const read = source && readCaptions(source.content);
    if (!source || !read) continue;
    const number = (name: string) => Number(host.getAttribute(name) ?? "0");
    placed.push({
      clipId: host.id,
      start: number("data-start"),
      duration: number("data-duration"),
      offset: number(
        host.hasAttribute("data-playback-start")
          ? "data-playback-start"
          : "data-media-start",
      ),
      file,
      version: source.version,
      ...read,
    });
  }
  return placed;
}

/** What a composition's root says about its frame and length, as captions need them. */
export function compositionFrame(html: string) {
  const root = parseSourceDocument(html).document.querySelector(
    "[data-composition-id]",
  );
  const fps = parseFpsWithDefault(root?.getAttribute("data-fps") ?? undefined);
  if (!root || !fps.ok)
    throw new HttpError(
      422,
      "Captions need a composition with a valid frame rate.",
    );
  const size = (name: string) => {
    const value = Number(root.getAttribute(name));
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  // Without a usable size, captions lay out for 1920 x 1080; without a length, to their last line.
  return {
    fps: fps.value,
    width: size("data-width") ?? 1920,
    height: size("data-height") ?? 1080,
    duration: size("data-duration") ?? Infinity,
  };
}

/** Caption words whose text differs from the transcript's, by word id. */
export function captionEdits(
  captions: Captions,
  transcript: Pick<Transcript, "words">,
) {
  const original = new Map(
    transcript.words.map((word) => [word.id, captionText(word.text)]),
  );
  return new Map(
    captions.groups.flatMap((group) =>
      group.words.flatMap((word) =>
        original.has(word.id) && original.get(word.id) !== word.text
          ? [[word.id, word.text] as const]
          : [],
      ),
    ),
  );
}

/**
 * Captions for the transcript's words where they now play, and the frames the clip needs to hold
 * them. Lines end by the composition's end; times inside are from the clip's first frame.
 */
export function layoutCaptions(
  view: TranscriptView,
  style: CaptionStyle,
  edits: ReadonlyMap<string, string>,
  composition: { fps: Fps; width: number; height: number; duration: number },
) {
  const words = view.words
    .flatMap((word) =>
      // A cut word can keep a sliver where a timeline edit rounded its piece to whole frames.
      word.cut ||
      word.timelineStart === null ||
      word.timelineEnd === null ||
      word.timelineEnd - word.timelineStart < SLIVER
        ? []
        : [
            {
              id: word.id,
              text: edits.get(word.id) ?? captionText(word.text),
              start: word.timelineStart,
              end: word.timelineEnd,
            },
          ],
    )
    .filter((word) => word.text && word.start < composition.duration)
    .sort((a, b) => a.start - b.start);
  const groups = groupWords(words, composition).map((group) => ({
    ...group,
    end: Math.min(group.end, composition.duration),
  }));
  if (!groups.length)
    throw new HttpError(
      422,
      "None of this transcript's words are on the timeline.",
    );
  const { fps } = composition;
  // The clip starts on the frame showing the first word and ends after the last line.
  const startFrame = Math.floor((groups[0]!.start * fps.num) / fps.den + 1e-6);
  const endFrame = Math.max(startFrame + 1, toFrames(groups.at(-1)!.end, fps));
  const offset = toSeconds(startFrame, fps);
  const at = (time: number) => canonicalSeconds(Math.max(0, time - offset));
  const captions: Captions = {
    style,
    transcriptId: view.id,
    groups: groups
      .map((group) => ({
        start: at(group.start),
        end: at(group.end),
        words: group.words.map((word) => ({
          id: word.id,
          text: word.text,
          start: at(word.start),
        })),
      }))
      .filter((group) => group.end > group.start),
  };
  return { captions, startFrame, durationFrames: endFrame - startFrame };
}

/** Whether two layouts show the same words over the same frames. */
const sameCaptions = (a: Captions, b: Captions) =>
  a.style === b.style &&
  a.groups.length === b.groups.length &&
  a.groups.every((group, index) => {
    const other = b.groups[index]!;
    return (
      Math.abs(group.start - other.start) < 0.001 &&
      Math.abs(group.end - other.end) < 0.001 &&
      group.words.length === other.words.length &&
      group.words.every(
        (word, wordIndex) =>
          word.id === other.words[wordIndex]!.id &&
          word.text === other.words[wordIndex]!.text &&
          Math.abs(word.start - other.words[wordIndex]!.start) < 0.001,
      )
    );
  });

/** The editor's and agents' view of placed captions, with lines in composition time. */
export function captionsView(
  placed: PlacedCaptions,
  transcript: Transcript,
  sourceFile: string,
  html: string,
): CaptionsView {
  const composition = compositionFrame(html);
  const edits = captionEdits(placed.captions, transcript);
  let stale = true;
  try {
    const view = transcriptView(transcript, parseSourceDocument(html).document);
    const layout = layoutCaptions(
      view,
      placed.captions.style,
      edits,
      composition,
    );
    stale =
      !sameCaptions(layout.captions, placed.captions) ||
      Math.abs(placed.start - toSeconds(layout.startFrame, composition.fps)) >
        0.0005 ||
      Math.abs(
        placed.duration - toSeconds(layout.durationFrames, composition.fps),
      ) > 0.0005 ||
      placed.offset !== 0;
  } catch (error) {
    // A transcript whose clip left the timeline has nothing to follow; its captions stay as written.
    if (!(error instanceof HttpError)) throw error;
  }
  const end = placed.start + placed.duration;
  return {
    transcriptId: transcript.id,
    sourceFile,
    file: placed.file,
    clipId: placed.clipId,
    style: placed.captions.style,
    stale,
    cues: placed.captions.groups.flatMap((group) => {
      const start = Math.max(
        placed.start,
        placed.start + group.start - placed.offset,
      );
      const stop = Math.min(end, placed.start + group.end - placed.offset);
      return stop > start
        ? [
            {
              start: canonicalSeconds(start),
              end: canonicalSeconds(stop),
              text: group.words.map((word) => word.text).join(" "),
            },
          ]
        : [];
    }),
    edits: Object.fromEntries(edits),
  };
}

/** The file write that replaces placed captions with `captions`, keeping their frame. */
export async function captionsWrite(
  project: Project,
  placed: PlacedCaptions,
  captions: Captions,
  duration = placed.duration,
): Promise<FileMutationInput> {
  const source = await readSource(project, placed.file);
  if (source.version !== placed.version)
    throw new HttpError(409, "The captions file changed. Try again.");
  return {
    sourceFile: placed.file,
    absPath: await projectWritePath(project, placed.file),
    before: source.content,
    after: renderCaptions(captions, placed.frame, duration),
    expectedVersion: source.version,
  };
}

/**
 * Rewrites a transcript's placed captions to follow its words where they play now, in the
 * composition `html`: the file gets the new lines, and the clip moves to hold them from their
 * first frame. Returns null when the composition has no readable captions of this transcript.
 */
export async function followTranscript(
  project: Project,
  transcript: Transcript,
  sourceFile: string,
  html: string,
  style?: CaptionStyle,
): Promise<{ html: string; files: FileMutationInput[] } | null> {
  const placed = (await placedCaptions(project, sourceFile, html)).find(
    (item) => item.captions.transcriptId === transcript.id,
  );
  if (!placed) return null;
  const composition = compositionFrame(html);
  const view = transcriptView(transcript, parseSourceDocument(html).document);
  const layout = layoutCaptions(
    view,
    style ?? placed.captions.style,
    captionEdits(placed.captions, transcript),
    composition,
  );
  const duration = toSeconds(layout.durationFrames, composition.fps);
  const patched = setElementAttributes(html, placed.clipId, [
    ["data-start", String(toSeconds(layout.startFrame, composition.fps))],
    ["data-duration", String(duration)],
    ["data-playback-start", null],
    ["data-media-start", null],
  ]);
  if (patched === null)
    throw new HttpError(409, "The captions clip changed. Try again.");
  return {
    html: patched,
    files: [await captionsWrite(project, placed, layout.captions, duration)],
  };
}
