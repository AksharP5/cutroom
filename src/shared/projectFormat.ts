import { z } from "zod";

export const pictureSizeRule =
  "Use even dimensions from 240 to 7680 pixels, up to 8K UHD total.";
const pictureDimension = z.number().int().min(240).max(7680).multipleOf(2);
export const withinPictureArea = ({
  width,
  height,
}: {
  width: number;
  height: number;
}) => width * height <= 7680 * 4320;
export const PictureSizeSchema = z
  .object({ width: pictureDimension, height: pictureDimension })
  .refine(withinPictureArea, pictureSizeRule);

export const projectRates = [
  { num: 16, den: 1 },
  { num: 18, den: 1 },
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 48000, den: 1001 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
  { num: 72, den: 1 },
  { num: 96000, den: 1001 },
  { num: 96, den: 1 },
  { num: 100, den: 1 },
  { num: 120000, den: 1001 },
  { num: 120, den: 1 },
] as const;

type Rate = { num: number; den: number };
const rateValue = ({ num, den }: Rate) => num / den;
export const rateLabel = (rate: Rate) =>
  String(Number(rateValue(rate).toFixed(3)));

const supportedRateRule = `Use one of these frame rates: ${projectRates.map(rateLabel).join(", ")} fps.`;

export const ProjectRateSchema = z
  .object({
    num: z.number().int().positive(),
    den: z.number().int().positive(),
  })
  .refine(
    ({ num, den }) =>
      projectRates.some((rate) => rate.num === num && rate.den === den),
    supportedRateRule,
  )
  .describe(
    `Exact frame rate as integers, e.g. {num: 60000, den: 1001} for 59.94 fps. ${supportedRateRule}`,
  );

export function matchProjectRate(fps: number): Rate | undefined {
  const closest = projectRates.reduce((best, rate) =>
    Math.abs(rateValue(rate) - fps) < Math.abs(rateValue(best) - fps)
      ? rate
      : best,
  );
  const value = rateValue(closest);
  return Math.abs(fps - value) / value <= 0.005 ? closest : undefined;
}

export const ProjectFormatSchema = PictureSizeSchema.safeExtend({
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

export const FormatPreviewSchema = z.object({
  movedEdges: z.number().int().nonnegative(),
  maxShiftMs: z.number().nonnegative(),
});
