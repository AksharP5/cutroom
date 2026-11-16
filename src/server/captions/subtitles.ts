import { HttpError } from "../../shared/errors";
import { SUBTITLE_LIMITS, captionText } from "../../shared/captions";
import type { SubtitleFormat } from "../../shared/captions";
import type { TranscriptWord } from "../../shared/project";

export interface Cue {
  start: number;
  end: number;
  text: string;
}

const TIMESTAMP = {
  srt: /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/,
  vtt: /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/,
} as const;
const EXAMPLE = { srt: "00:00:01,500", vtt: "00:00:01.500" } as const;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lrm: "",
  rlm: "",
};

const refuse = (line: number, message: string): never => {
  throw new HttpError(400, `Line ${line}: ${message}`);
};

function timestamp(raw: string, format: SubtitleFormat, line: number) {
  const match = TIMESTAMP[format].exec(raw);
  if (!match)
    return refuse(
      line,
      `"${raw.slice(0, 40)}" is not a ${format.toUpperCase()} time like ${EXAMPLE[format]}.`,
    );
  const [, hours = "0", minutes, secs, millis] = match;
  const value =
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(secs) +
    Number(millis) / 1000;
  if (value > SUBTITLE_LIMITS.seconds)
    return refuse(line, "Subtitle times can be up to 24 hours.");
  return value;
}

/**
 * Cue text as plain words: styling tags, voice spans, karaoke timestamps and override blocks are
 * dropped, the entities subtitle files use are decoded, and lines join with a space.
 */
const plainText = (lines: string[]) =>
  captionText(
    lines
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(/\{\\[^}]*\}/g, "")
      .replace(
        /&(amp|lt|gt|quot|apos|nbsp|lrm|rlm);/g,
        (_, name: string) => ENTITIES[name]!,
      ),
  );

/**
 * Reads an SRT or WebVTT file into cues, in start order. Anything outside the format is refused
 * with its line, and the file's size, cue count, text and times are bounded.
 */
export function parseSubtitles(raw: string, format: SubtitleFormat): Cue[] {
  if (raw.length > SUBTITLE_LIMITS.bytes)
    throw new HttpError(400, "Subtitle files can be up to 2 MB.");
  const lines = raw
    .replace(/^﻿/, "")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd());
  const blocks: { line: number; lines: string[] }[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    const previous = blocks.at(-1);
    if (previous && lines[index - 1] !== "") previous.lines.push(line);
    else blocks.push({ line: index + 1, lines: [line] });
  }
  if (format === "vtt") {
    const header = blocks.shift();
    if (!header || !/^WEBVTT(?:[ \t].*)?$/.test(header.lines[0]!))
      throw new HttpError(400, "Line 1: A WebVTT file starts with WEBVTT.");
  }
  const cues: Cue[] = [];
  for (const block of blocks) {
    if (
      format === "vtt" &&
      /^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/.test(block.lines[0]!)
    )
      continue;
    const timing = block.lines.findIndex((line) => line.includes("-->"));
    // An SRT cue is numbered; a WebVTT cue may have an identifier. Either way, one line at most.
    if (timing < 0 || timing > 1)
      refuse(
        block.line,
        "Expected a cue time line like 00:00:01,500 --> 00:00:03,000.",
      );
    if (format === "srt" && timing === 1 && !/^\d+$/.test(block.lines[0]!))
      refuse(block.line, "An SRT cue starts with its number.");
    const at = block.line + timing;
    const times = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t].*)?$/.exec(
      block.lines[timing]!,
    );
    if (!times) return refuse(at, "Expected two times separated by -->.");
    const start = timestamp(times[1]!, format, at);
    const end = timestamp(times[2]!, format, at);
    if (end <= start) refuse(at, "A cue must end after it starts.");
    const text = plainText(block.lines.slice(timing + 1));
    if (text.length > SUBTITLE_LIMITS.cueText)
      refuse(at, "A cue can hold up to 2,000 characters.");
    if (!text) continue;
    cues.push({ start, end, text });
    if (cues.length > SUBTITLE_LIMITS.cues)
      throw new HttpError(400, "Subtitle files can hold up to 20,000 cues.");
  }
  if (!cues.length)
    throw new HttpError(400, "The subtitle file has no cues with text.");
  return cues.sort((a, b) => a.start - b.start);
}

/** The cue an imported subtitle word came from, so captions keep the file's line breaks. */
export const cueOf = (wordId: string) => /^cue-(\d+)-\d+$/.exec(wordId)?.[1];

/**
 * Transcript words from cues. A cue has no word timing, so its words share its time in
 * proportion to their length; they start in order and end before the next word starts.
 */
export function cueWords(cues: readonly Cue[]): TranscriptWord[] {
  const words = cues.flatMap((cue, cueIndex) => {
    const texts = cue.text.split(" ");
    const weights = texts.map((text) => text.length + 1);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let elapsed = 0;
    return texts.map((text, index) => {
      const start = cue.start + ((cue.end - cue.start) * elapsed) / total;
      elapsed += weights[index]!;
      const end = cue.start + ((cue.end - cue.start) * elapsed) / total;
      return { id: `cue-${cueIndex + 1}-${index + 1}`, text, start, end };
    });
  });
  // Overlapping cues interleave their words; transcripts are in start order.
  return words.sort((a, b) => a.start - b.start);
}

const clock = (seconds: number, separator: "," | ".") => {
  const millis = Math.round(seconds * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(Math.floor(millis / 3_600_000))}:${pad(Math.floor(millis / 60_000) % 60)}:${pad(Math.floor(millis / 1000) % 60)}${separator}${pad(millis % 1000, 3)}`;
};

/** An SRT or WebVTT file of the cues, in milliseconds. A cue never collapses to nothing. */
export function formatSubtitles(
  cues: readonly Cue[],
  format: SubtitleFormat,
): string {
  const separator = format === "srt" ? "," : ".";
  const body = cues.map((cue, index) => {
    const start = Math.round(cue.start * 1000) / 1000;
    const end = Math.max(Math.round(cue.end * 1000) / 1000, start + 0.001);
    // A cue line holding --> would read as a time line; WebVTT text also escapes markup.
    const text = cue.text.replaceAll("-->", "->");
    return [
      ...(format === "srt" ? [String(index + 1)] : []),
      `${clock(start, separator)} --> ${clock(end, separator)}`,
      format === "vtt"
        ? text
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
        : text,
    ].join("\n");
  });
  return `${format === "vtt" ? "WEBVTT\n\n" : ""}${body.join("\n\n")}\n`;
}
