import { bakeHfColorGradingTexture } from "@hyperframes/core/color-grading-bake";
import { parseCubeLut } from "@hyperframes/core/color-luts";
import type { Grade } from "../../shared/timeline/grade";

export interface FilmGradeJob {
  key: string;
  gradeKey: string;
  grade: Grade;
  look?: string;
  image: ImageBitmap;
}

export type FilmGradeResult =
  { key: string; image: ImageBitmap } | { key: string; error: string };

const SIZE = 33;
const STRIDES = [4, 4 * SIZE, 4 * SIZE * SIZE] as const;
const grid = Array.from({ length: 256 }, (_, byte) => {
  const position = (byte * (SIZE - 1)) / 255;
  const low = Math.min(SIZE - 2, Math.floor(position));
  return { low, fraction: position - low };
});

const cubes = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
let recentLook:
  { url: string; lut: Promise<ReturnType<typeof parseCubeLut>> } | undefined;

function readLook(url: string) {
  if (recentLook?.url !== url) {
    const lut = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error("Could not load the look LUT.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await response.arrayBuffer(),
      );
      return parseCubeLut(text, { maxSize: 65 });
    });
    recentLook = { url, lut };
  }
  return recentLook.lut;
}

function cubeFor({ gradeKey, grade, look }: FilmGradeJob) {
  let cube = cubes.get(gradeKey);
  if (!cube) {
    cube = (async () => {
      const lut = look ? await readLook(look) : null;
      return bakeHfColorGradingTexture(grade, SIZE, lut);
    })();
    if (cubes.size >= 16) cubes.delete(cubes.keys().next().value!);
  }
  cubes.delete(gradeKey);
  cubes.set(gradeKey, cube);
  return cube;
}

const canvas = new OffscreenCanvas(1, 1);
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

/** Sample the baked RGB cube the same way the viewer's filterable 3D texture does. */
function shade(image: ImageBitmap, cube: Uint8Array) {
  const { width, height } = image;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height);
  const { data } = pixels;
  const [dx, dy, dz] = STRIDES;
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3] === 0) continue;
    const red = grid[data[at]!]!;
    const green = grid[data[at + 1]!]!;
    const blue = grid[data[at + 2]!]!;
    const corner = red.low * dx + green.low * dy + blue.low * dz;
    for (let channel = 0; channel < 3; channel++) {
      const c = corner + channel;
      const low =
        interpolate(cube[c]!, cube[c + dx]!, red.fraction) *
          (1 - green.fraction) +
        interpolate(cube[c + dy]!, cube[c + dy + dx]!, red.fraction) *
          green.fraction;
      const high =
        interpolate(cube[c + dz]!, cube[c + dz + dx]!, red.fraction) *
          (1 - green.fraction) +
        interpolate(cube[c + dz + dy]!, cube[c + dz + dy + dx]!, red.fraction) *
          green.fraction;
      data[at + channel] = interpolate(low, high, blue.fraction);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas.transferToImageBitmap();
}

const interpolate = (from: number, to: number, fraction: number) =>
  from + (to - from) * fraction;

self.onmessage = async ({ data }: MessageEvent<FilmGradeJob[]>) => {
  const results = await Promise.all(
    data.map(async (job): Promise<FilmGradeResult> => {
      try {
        return { key: job.key, image: shade(job.image, await cubeFor(job)) };
      } catch (error) {
        return {
          key: job.key,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        job.image.close();
      }
    }),
  );
  self.postMessage(results, {
    transfer: results.flatMap((result) =>
      "image" in result ? [result.image] : [],
    ),
  });
};
