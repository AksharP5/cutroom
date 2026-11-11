import { expect, test } from "bun:test";
import { frameSummary } from "../scripts/timeline-performance";

test.each([
  { maxima: [80, 171, 90], median: 90, passes: true },
  { maxima: [171, 141, 164], median: 164, passes: false },
])("frame budget for run maxima $maxima", ({ maxima, median, passes }) => {
  const results = maxima.map((max) => ({
    interaction: "ripple" as const,
    frames: [16, 17, max],
    longTasks: [max - 1],
    inputs: 0,
  }));
  const summary = frameSummary(results).ripple;
  expect(summary.medianMax).toBe(median);
  expect(summary.medianMax < 150).toBe(passes);
  expect(summary.max).toBe(171);
  expect(summary.longTasks).toBe(3);
  expect(results.map((result) => result.frames.at(-1))).toEqual([...maxima]);
});
