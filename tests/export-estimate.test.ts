import { expect, test } from "bun:test";
import {
  estimateExportStage,
  sampleExportRate,
} from "../src/client/edit/exportEstimate";

test("startup progress cannot become a time-left estimate", () => {
  expect(
    sampleExportRate(null, { code: "start_browsers", done: 6, total: 6 }, 500),
  ).toBeNull();
  const first = sampleExportRate(
    null,
    { code: "capture", done: 0, total: 600 },
    500,
  );
  const early = sampleExportRate(
    first,
    { code: "capture", done: 10, total: 600 },
    1000,
  );
  expect(estimateExportStage(early, 1000)).toBeNull();
  const useful = sampleExportRate(
    early,
    { code: "capture", done: 60, total: 600 },
    2500,
  );
  expect(estimateExportStage(useful, 2500)).toEqual({
    milliseconds: 18000,
    stage: "capture",
  });
});

test("a new stage or retried capture needs its own measured throughput", () => {
  const first = sampleExportRate(
    null,
    { code: "capture", done: 0, total: 60 },
    0,
  );
  const captured = sampleExportRate(
    first,
    { code: "capture", done: 30, total: 60 },
    1000,
  );
  expect(estimateExportStage(captured, 1000)?.milliseconds).toBe(1000);
  const encode = sampleExportRate(
    captured,
    { code: "encode", done: 10, total: 60 },
    1500,
  );
  expect(estimateExportStage(encode, 1500)).toBeNull();
  const retried = sampleExportRate(
    captured,
    { code: "capture", done: 1, total: 60 },
    2000,
  );
  expect(estimateExportStage(retried, 2000)).toBeNull();
  expect(estimateExportStage(captured, 5000)).toBeNull();
  expect(sampleExportRate(captured, { code: "assemble" }, 2000)).toBeNull();
});
