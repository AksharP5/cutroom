import { z } from "zod";

export const pictureDimension = z.number().int().min(240).max(7680);
export const PictureSizeSchema = z.object({
  width: pictureDimension,
  height: pictureDimension,
});

export const ProjectRateSchema = z
  .object({
    num: z.number().int().positive(),
    den: z.number().int().positive(),
  })
  .refine(
    ({ num, den }) => num >= den && num / den <= 240,
    "Use a frame rate from 1 to 240 fps.",
  )
  .describe(
    "Exact frame rate as integers, e.g. {num: 60000, den: 1001} for 59.94 fps.",
  );

export const ProjectFormatSchema = PictureSizeSchema.extend({
  fps: ProjectRateSchema,
});
export type ProjectFormat = z.infer<typeof ProjectFormatSchema>;

export const defaultFormat: ProjectFormat = {
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
};

export function sameRate(a: ProjectFormat["fps"], b: ProjectFormat["fps"]) {
  return (
    (a.num === b.num && a.den === b.den) ||
    BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den)
  );
}

export const rateLabel = ({ num, den }: ProjectFormat["fps"]) =>
  String(Number((num / den).toFixed(3)));

export const FormatPreviewSchema = z.object({
  movedEdges: z.number().int().nonnegative(),
  maxShiftMs: z.number().nonnegative(),
});
