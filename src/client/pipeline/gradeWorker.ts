import { bakeHfColorGradingTexture } from "@hyperframes/core/color-grading-bake";
import { parseCubeLut } from "@hyperframes/core/color-luts";
import type { Grade } from "../../shared/timeline/grade";

export type GradeRequest = {
  key: string;
  grade: Grade;
  size: number;
  lutUrl?: string;
};
export type GradeReply =
  | { key: string; data: Uint8Array<ArrayBuffer> }
  | { key: string; error: string };

// Slider steps often share one look. Keep just the last look and share its in-flight read.
let look:
  { url: string; lut: Promise<ReturnType<typeof parseCubeLut>> } | undefined;

self.onmessage = async ({
  data: { key, grade, size, lutUrl },
}: MessageEvent<GradeRequest>) => {
  try {
    if (lutUrl && look?.url !== lutUrl) {
      look = {
        url: lutUrl,
        lut: fetch(lutUrl).then(async (response) => {
          if (!response.ok)
            throw new Error("The clip's look LUT could not be read.");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            await response.arrayBuffer(),
          );
          return parseCubeLut(text, { maxSize: 65 });
        }),
      };
    }
    const lut = lutUrl ? await look?.lut : null;
    const data = bakeHfColorGradingTexture(grade, size, lut);
    self.postMessage({ key, data } satisfies GradeReply, {
      transfer: [data.buffer],
    });
  } catch (error) {
    self.postMessage({
      key,
      error: error instanceof Error ? error.message : String(error),
    } satisfies GradeReply);
  }
};
