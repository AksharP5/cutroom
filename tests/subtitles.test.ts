import { expect, test } from "bun:test";
import {
  cueWords,
  formatSubtitles,
  parseSubtitles,
} from "../src/server/captions/subtitles";
import { SUBTITLE_LIMITS } from "../src/shared/captions";
import { WordSchema } from "../src/shared/project";

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "accepted";
};

test("an SRT with styling, CRLF and cues out of order reads as plain timed lines and writes back as WebVTT", () => {
  const srt =
    "﻿2\r\n00:00:04,000 --> 00:00:05,250\r\n<i>Second</i> &amp; {\\an8}last\r\n\r\n" +
    "1\r\n00:00:01,500 --> 00:00:03,000\r\nFirst line\r\nwraps here\r\n";
  const cues = parseSubtitles(srt, "srt");
  expect(cues).toEqual([
    { start: 1.5, end: 3, text: "First line wraps here" },
    { start: 4, end: 5.25, text: "Second & last" },
  ]);
  expect(formatSubtitles(cues, "vtt")).toBe(
    "WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nFirst line wraps here\n\n00:00:04.000 --> 00:00:05.250\nSecond &amp; last\n",
  );
  expect(formatSubtitles(cues, "srt")).toBe(
    "1\n00:00:01,500 --> 00:00:03,000\nFirst line wraps here\n\n2\n00:00:04,000 --> 00:00:05,250\nSecond & last\n",
  );
});

test("WebVTT notes, styles, identifiers, cue settings and voice tags are read the way players read them", () => {
  const vtt = [
    "WEBVTT - talk",
    "",
    "NOTE written by hand",
    "",
    "STYLE",
    "::cue { color: red }",
    "",
    "intro",
    "00:01.000 --> 00:02.500 align:start position:10%",
    "<v Ada>Hello <00:01.500>there</v>",
    "",
    "01:00:00.000 --> 01:00:01.000",
    "Later",
  ].join("\n");
  expect(parseSubtitles(vtt, "vtt")).toEqual([
    { start: 1, end: 2.5, text: "Hello there" },
    { start: 3600, end: 3601, text: "Later" },
  ]);
});

test("malformed or oversized subtitle files are refused with the line at fault", () => {
  const cue = (time: string) => `1\n${time}\nText\n`;
  expect(
    refusal(() => parseSubtitles(cue("00:00:01 --> 00:00:02,000"), "srt")),
  ).toBe('Line 2: "00:00:01" is not a SRT time like 00:00:01,500.');
  expect(
    refusal(() => parseSubtitles(cue("00:61:00,000 --> 00:62:00,000"), "srt")),
  ).toContain("Line 2");
  expect(
    refusal(() => parseSubtitles(cue("00:00:02,000 --> 00:00:01,000"), "srt")),
  ).toBe("Line 2: A cue must end after it starts.");
  expect(
    refusal(() =>
      parseSubtitles("one\n00:00:01,000 --> 00:00:02,000\nx\n", "srt"),
    ),
  ).toBe("Line 1: An SRT cue starts with its number.");
  expect(
    refusal(() => parseSubtitles(cue("25:00:00,000 --> 25:00:01,000"), "srt")),
  ).toBe("Line 2: Subtitle times can be up to 24 hours.");
  expect(
    refusal(() =>
      parseSubtitles("00:00.000 --> 00:01.000\nNo header\n", "vtt"),
    ),
  ).toBe("Line 1: A WebVTT file starts with WEBVTT.");
  expect(refusal(() => parseSubtitles("WEBVTT\n\nNOTE only\n", "vtt"))).toBe(
    "The subtitle file has no cues with text.",
  );
  expect(
    refusal(() =>
      parseSubtitles(
        `1\n00:00:01,000 --> 00:00:02,000\n${"a".repeat(SUBTITLE_LIMITS.cueText + 1)}\n`,
        "srt",
      ),
    ),
  ).toBe("Line 2: A cue can hold up to 2,000 characters.");
  const many = Array.from(
    { length: SUBTITLE_LIMITS.cues + 1 },
    (_, index) => `${index + 1}\n00:00:01,000 --> 00:00:02,000\nx`,
  ).join("\n\n");
  expect(refusal(() => parseSubtitles(many, "srt"))).toBe(
    "Subtitle files can hold up to 20,000 cues.",
  );
  expect(
    refusal(() => parseSubtitles("x".repeat(SUBTITLE_LIMITS.bytes + 1), "srt")),
  ).toBe("Subtitle files can be up to 2 MB.");
});

test("a cue's words share its time by length, in order, as valid transcript words", () => {
  const words = cueWords([{ start: 10, end: 12, text: "I am here" }]);
  expect(
    words.map((word) => [word.id, word.text, word.start, word.end]),
  ).toEqual([
    ["cue-1-1", "I", 10, 10.4],
    ["cue-1-2", "am", 10.4, 11],
    ["cue-1-3", "here", 11, 12],
  ]);
  for (const word of words)
    expect(WordSchema.safeParse(word).success).toBe(true);
});
