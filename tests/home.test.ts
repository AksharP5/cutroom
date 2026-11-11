import { expect, test } from "bun:test";
import {
  aspectLabel,
  durationLabel,
  editedLabel,
  gridStep,
  posterUrl,
} from "../src/client/home";

test("last edited reads as an age for a week, then as a date", () => {
  const now = new Date(2026, 5, 20, 12).getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  expect(editedLabel(ago(59_000), now)).toBe("Just now");
  // A clock a little behind the server's must not read as a negative age.
  expect(editedLabel(ago(-5_000), now)).toBe("Just now");
  expect(editedLabel(ago(minute), now)).toBe("1 min ago");
  expect(editedLabel(ago(hour - 1), now)).toBe("59 min ago");
  expect(editedLabel(ago(2 * hour + 59 * minute), now)).toBe("2 h ago");
  expect(editedLabel(ago(day), now)).toBe("1 d ago");
  expect(editedLabel(ago(7 * day - 1), now)).toBe("6 d ago");
  const thisYear = editedLabel(ago(8 * day), now);
  expect(thisYear).toContain("12");
  expect(thisYear).not.toContain("ago");
  expect(thisYear).not.toContain("2026");
  expect(editedLabel(ago(300 * day), now)).toContain("2025");
});

test("durations drop the hours until there are any", () => {
  expect(durationLabel(0)).toBe("0:00");
  expect(durationLabel(12)).toBe("0:12");
  expect(durationLabel(94)).toBe("1:34");
  expect(durationLabel(1265)).toBe("21:05");
  expect(durationLabel(3754)).toBe("1:02:34");
  // Rounding carries into the next unit instead of printing 59:60.
  expect(durationLabel(3599.6)).toBe("1:00:00");
});

test("aspect is a small ratio when one exists and a decimal otherwise", () => {
  expect(aspectLabel(1920, 1080)).toBe("16:9");
  expect(aspectLabel(3840, 2160)).toBe("16:9");
  expect(aspectLabel(1080, 1920)).toBe("9:16");
  expect(aspectLabel(1080, 1080)).toBe("1:1");
  expect(aspectLabel(1440, 1080)).toBe("4:3");
  expect(aspectLabel(2048, 858)).toBe("2.39:1");
  expect(aspectLabel(858, 2048)).toBe("1:2.39");
});

test("the poster is the frame a second in, or the middle of a shorter project", () => {
  const project = { id: "a b", updatedAt: "2026-06-20T12:00:00.000Z" };
  const long = new URL(posterUrl(project, { duration: 90 }), "http://x");
  expect(long.pathname).toBe("/api/projects/a%20b/thumbnail/index.html");
  expect(long.searchParams.get("t")).toBe("1.00");
  expect(
    new URL(posterUrl(project, { duration: 1 }), "http://x").searchParams.get(
      "t",
    ),
  ).toBe("0.50");
  // An edit changes the address, so an open home asks for the new frame.
  expect(posterUrl(project, { duration: 90 })).not.toBe(
    posterUrl(
      { ...project, updatedAt: "2026-06-20T12:05:00.000Z" },
      {
        duration: 90,
      },
    ),
  );
});

test("arrow keys walk a grid whose last row is short", () => {
  // Twelve tiles in five columns: rows of 5, 5 and 2.
  const step = (key: string, index: number) => gridStep(key, index, 5, 12);
  expect(step("ArrowRight", 4)).toBe(5);
  expect(step("ArrowRight", 11)).toBeNull();
  expect(step("ArrowLeft", 5)).toBe(4);
  expect(step("ArrowLeft", 0)).toBeNull();
  expect(step("ArrowDown", 1)).toBe(6);
  expect(step("ArrowDown", 6)).toBe(11);
  // Below the third column there is no tile, so the last one takes focus.
  expect(step("ArrowDown", 8)).toBe(11);
  expect(step("ArrowDown", 10)).toBeNull();
  expect(step("ArrowUp", 11)).toBe(6);
  expect(step("ArrowUp", 3)).toBeNull();
  expect(step("Home", 7)).toBe(0);
  expect(step("End", 7)).toBe(11);
  expect(step("Enter", 7)).toBeNull();
});
