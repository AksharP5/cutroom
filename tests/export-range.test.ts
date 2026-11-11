import { expect, test } from "bun:test";
import {
  defaultExportRange,
  exportRange,
  ExportOptionsSchema,
} from "../src/shared/export";

test("both marks default to In to Out, with an exclusive engine Out", () => {
  const timeline = { duration: 300, range: { in: 30, out: 91 } };
  expect(defaultExportRange(timeline)).toBe("marks");
  expect(exportRange(timeline, "marks")).toEqual({ start: 30, end: 91 });
  expect(exportRange(timeline, "timeline")).toEqual({ start: 0, end: 300 });
});

test("a single mark defaults to the whole timeline and refuses an explicit marked export", () => {
  for (const range of [
    { in: 30, out: null },
    { in: null, out: 91 },
    { in: null, out: null },
  ]) {
    const timeline = { duration: 300, range };
    expect(defaultExportRange(timeline)).toBe("timeline");
    expect(exportRange(timeline, "timeline")).toEqual({ start: 0, end: 300 });
    expect(() => exportRange(timeline, "marks")).toThrow("Set both In and Out");
  }
});

test("empty, reversed and out-of-bounds ranges cannot start an export", () => {
  expect(() =>
    exportRange({ duration: 0, range: { in: null, out: null } }, "timeline"),
  ).toThrow("empty");
  for (const range of [
    { in: 90, out: 30 },
    { in: 30, out: 30 },
    { in: 300, out: 400 },
  ])
    expect(() => exportRange({ duration: 300, range }, "marks")).toThrow(
      "inside",
    );
});

test("an Out left past the end by a ripple delete stops at the end, as playback does", () => {
  expect(
    exportRange({ duration: 300, range: { in: 30, out: 450 } }, "marks"),
  ).toEqual({ start: 30, end: 300 });
});

test("export names cannot direct writes to other files", () => {
  for (const filename of [
    "../source.mp4",
    "nested/file.mp4",
    "file\\name.mp4",
    "cutroom.json",
    "bad\0.mp4",
  ])
    expect(
      ExportOptionsSchema.safeParse({
        filename,
        directory: "/tmp",
        range: null,
      }).success,
    ).toBe(false);
});
