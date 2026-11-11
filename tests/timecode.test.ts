import { expect, test } from "bun:test";
import { formatTimecode, parseTimecode } from "../src/shared/timeline/timecode";

const ntsc24 = { num: 24000, den: 1001 };
const ntsc30 = { num: 30000, den: 1001 };
const thirty = { num: 30, den: 1 };

test("timecode counts frames at the nominal rate, without drop frames", () => {
  expect(formatTimecode(0, thirty)).toBe("00:00:00:00");
  expect(formatTimecode(29, thirty)).toBe("00:00:00:29");
  expect(formatTimecode(30, thirty)).toBe("00:00:01:00");
  expect(formatTimecode(30 * 3661 + 7, thirty)).toBe("01:01:01:07");
  expect(formatTimecode(23, ntsc24)).toBe("00:00:00:23");
  expect(formatTimecode(24, ntsc24)).toBe("00:00:01:00");
  expect(formatTimecode(1799, ntsc30)).toBe("00:00:59:29");
  expect(formatTimecode(1800, ntsc30)).toBe("00:01:00:00");
});

test("typed digits fill from the right", () => {
  expect(parseTimecode("1204", thirty)).toBe(12 * 30 + 4);
  expect(parseTimecode("1204", ntsc24)).toBe(12 * 24 + 4);
  expect(parseTimecode("1204", ntsc30)).toBe(12 * 30 + 4);
  expect(parseTimecode("5", thirty)).toBe(5);
  expect(parseTimecode("01000000", ntsc24)).toBe(3600 * 24);
});

test("parse and format agree on every rate", () => {
  for (const fps of [ntsc24, ntsc30, thirty])
    for (const frame of [0, 1, 23, 24, 29, 30, 1799, 1800, 86_399])
      expect(
        parseTimecode(formatTimecode(frame, fps).replaceAll(":", ""), fps),
      ).toBe(frame);
});

test("frames past the rate carry, and nothing else parses", () => {
  expect(parseTimecode("0099", thirty)).toBe(99);
  expect(parseTimecode("", thirty)).toBeNull();
  expect(parseTimecode("12:04", thirty)).toBeNull();
  expect(parseTimecode("123456789", thirty)).toBeNull();
});
