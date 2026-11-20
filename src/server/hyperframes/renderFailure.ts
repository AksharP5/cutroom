import type { ExportStage } from "../../shared/export.ts";

export class ExportStageError extends Error {
  readonly stage: ExportStage["code"];

  constructor(stage: ExportStage["code"], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.stage = stage;
  }
}

const stages = {
  compile: [
    "Preparing the composition",
    "Check that the project opens in the editor, then try again.",
  ],
  extract_video: [
    "Reading source video",
    "Check that the source clips play in the editor.",
  ],
  process_audio: [
    "Mixing audio",
    "Check that the audio clips play in the editor.",
  ],
  start_browsers: [
    "Starting Chromium",
    "Try again and check the Chromium installation if it repeats.",
  ],
  capture: ["Capturing frames", "Try again with a shorter marked range."],
  encode: [
    "Encoding video",
    "Try again with a shorter marked range or a lower output size.",
  ],
  assemble: [
    "Assembling the export",
    "Try exporting to another writable folder.",
  ],
} satisfies Record<ExportStage["code"], [string, string]>;

/** Keep browser diagnostics and stacks in the server log, and give the editor a next step. */
export function renderFailure(stage: ExportStage["code"], cause: string) {
  console.warn(`Export failed while ${stages[stage][0].toLowerCase()}:`, cause);
  const [label, retry] = stages[stage];
  const prefix = `${label} failed.`;
  if (
    /\b(?:ENOSPC|EDQUOT)\b|no space left on device|disk quota exceeded/i.test(
      cause,
    )
  )
    return `${prefix} Free space on the export and Cutroom data drives, then try again.`;
  if (/\b(?:EPIPE|EIO)\b|unknown error, write|broken pipe/i.test(cause))
    return `${prefix} A write stopped before it finished. Check available disk space. ${retry}`;
  if (/Runtime\.evaluate timed out|Navigation timeout of/i.test(cause))
    return `${prefix} Chromium stopped responding. ${retry}`;
  if (/\[Parallel\] Capture failed:|\[Browser:[A-Z]+\]/i.test(cause))
    return `${prefix} ${retry}`;
  const detail = (
    cause.match(/^Error(?: \[[^\]]+\])?: (.+)$/m)?.[1] ??
    cause.trim().split("\n", 1)[0]
  )?.trim();
  return [prefix, detail?.slice(0, 300), retry].filter(Boolean).join(" ");
}
