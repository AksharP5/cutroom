import { copyFile } from "node:fs/promises";
import { runFfmpeg } from "@hyperframes/engine";

/** AAC packet ownership can omit part of either boundary. Trim the plan's
 * complete mix at sample precision and copy the already encoded video. */
export async function alignRangeAudio(input: {
  videoPath: string;
  audioPath: string | null;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  if (!input.audioPath) {
    await copyFile(input.videoPath, input.outputPath);
    return;
  }
  const result = await runFfmpeg(
    [
      "-i",
      input.videoPath,
      "-i",
      input.audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-af",
      `atrim=start=${input.startSeconds}:duration=${input.durationSeconds},asetpts=PTS-STARTPTS,apad`,
      "-t",
      String(input.durationSeconds),
      "-movflags",
      "+faststart",
      "-y",
      input.outputPath,
    ],
    { signal: input.signal },
  );
  if (!result.success)
    throw new Error(`Range audio alignment failed: ${result.stderr}`);
}
