import type { GradeTexture } from "../pipeline/grades";
import { applyFilmGrade } from "./filmGradeLookup";

export interface FilmGradeJob {
  key: string;
  image: ImageBitmap;
  cube: GradeTexture;
}

export type FilmGradeResult =
  { key: string; image: ImageBitmap } | { key: string; error: string };

const canvas = new OffscreenCanvas(1, 1);
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

function shade({ image, cube }: FilmGradeJob) {
  const { width, height } = image;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height);
  applyFilmGrade(pixels.data, cube.data, cube.size);
  ctx.putImageData(pixels, 0, 0);
  return canvas.transferToImageBitmap();
}

self.onmessage = ({ data }: MessageEvent<FilmGradeJob[]>) => {
  const results = data.map((job): FilmGradeResult => {
    try {
      return { key: job.key, image: shade(job) };
    } catch (error) {
      return {
        key: job.key,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      job.image.close();
    }
  });
  self.postMessage(results, {
    transfer: results.flatMap((result) =>
      "image" in result ? [result.image] : [],
    ),
  });
};
