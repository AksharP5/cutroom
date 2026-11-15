import { execFile } from "node:child_process";

/**
 * NVENC settings for each quality, chosen to match or beat libx264's quality at that tier on
 * camera, screen and grain footage (docs/performance.md, GPU encoding). CQ is not CRF: CQ 23
 * lands where CRF 18 does.
 */
export const NVENC = {
  draft: { preset: "p3", quality: 30 },
  standard: { preset: "p5", quality: 23 },
  high: { preset: "p5", quality: 20 },
} as const;

/**
 * Whether this machine's FFmpeg can encode a 1080p frame with NVENC at Standard's settings. False
 * without an NVIDIA GPU, its driver, or an FFmpeg built with NVENC; about 0.4 s when it works.
 */
export function probeNvenc() {
  const { preset, quality } = NVENC.standard;
  return new Promise<boolean>((resolve) =>
    execFile(
      "ffmpeg",
      [
        ...["-v", "error", "-nostdin", "-f", "lavfi", "-i"],
        "color=size=1920x1080:rate=30,format=yuv420p",
        ...["-frames:v", "1", "-c:v", "h264_nvenc", "-preset", preset],
        ...["-cq", String(quality), "-bf", "0", "-f", "null", "-"],
      ],
      { timeout: 15_000 },
      (error) => resolve(!error),
    ),
  );
}
