import type { ExportStage } from "./export";

export interface ExportRate {
  code: ExportStage["code"];
  firstDone: number;
  firstAt: number;
  done: number;
  total: number;
  updatedAt: number;
}

export function sampleExportRate(
  previous: ExportRate | null,
  stage: ExportStage | undefined,
  now: number,
): ExportRate | null {
  if (
    !stage ||
    !["capture", "encode", "extract_video"].includes(stage.code) ||
    stage.done === undefined ||
    stage.total === undefined ||
    stage.done >= stage.total
  )
    return null;
  if (
    !previous ||
    previous.code !== stage.code ||
    previous.total !== stage.total ||
    stage.done < previous.done
  )
    return {
      code: stage.code,
      firstDone: stage.done,
      firstAt: now,
      done: stage.done,
      total: stage.total,
      updatedAt: now,
    };
  if (stage.done === previous.done) return previous;
  return { ...previous, done: stage.done, updatedAt: now };
}

export function estimateExportStage(rate: ExportRate | null, now: number) {
  if (!rate || now - rate.updatedAt > 3000) return null;
  const elapsed = rate.updatedAt - rate.firstAt;
  const frames = rate.done - rate.firstDone;
  if (elapsed < 1000 || frames < 5) return null;
  return {
    milliseconds: ((rate.total - rate.done) * elapsed) / frames,
    stage:
      rate.code === "capture"
        ? "capture"
        : rate.code === "encode"
          ? "encoding"
          : "video extraction",
  };
}
