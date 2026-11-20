import {
  COLOR_GRADING_ADJUST_KEYS,
  COLOR_GRADING_CURVE_KEYS,
  COLOR_GRADING_HUE_CURVE_KEYS,
  COLOR_GRADING_MAX_CURVE_POINTS,
  COLOR_GRADING_MAX_SECONDARIES,
  COLOR_GRADING_WHEEL_KEYS,
  validateColorGradingContract,
} from "@hyperframes/parsers/color-grading-contract";
import { z } from "zod";
import type { Clip } from "./schema.ts";

/**
 * A clip's colour grade: the colour stages of HyperFrames' `data-color-grading`, which its runtime
 * draws in the preview and in frame capture, and which `bakeHfColorGradingCube` turns into a 3D LUT
 * for FFmpeg and other editors. Only stages a LUT can hold are here: no grain, vignette or effects.
 * The runtime works on the picture as the browser decodes it, display-referred BT.709 RGB from 0 to
 * 1, in this order: basic, wheels, curves, hue curves, secondaries, then the look LUT, all mixed
 * with the source by `intensity`.
 */

export const GRADE_ATTRIBUTE = "data-color-grading";
export const LUT_DIRECTORY = "luts";

/** Two decimals more than a slider shows, so a value reads back exactly as it was written. */
const number = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .overwrite((value) => Number(value.toFixed(4)) + 0);
const unit = number(0, 1);
const signed = number(-1, 1);

const ADJUST_DESCRIPTIONS = {
  exposure: "Stops of exposure, -2 to 2: 1 doubles the light",
  contrast: "-1 flattens to grey, 1 doubles contrast about mid grey",
  highlights: "Lifts (positive) or recovers (negative) the bright tones",
  shadows: "Lifts (positive) or deepens (negative) the dark tones",
  whites: "Moves the white point: positive brightens it, negative dims it",
  blacks: "Moves the black point: positive crushes, negative lifts",
  temperature: "Positive is warmer (orange), negative cooler (blue)",
  tint: "Positive is magenta, negative green",
  vibrance: "Saturation that spares skin and already saturated colour",
  saturation: "-1 is black and white, 1 doubles saturation",
} satisfies Record<(typeof COLOR_GRADING_ADJUST_KEYS)[number], string>;

const AdjustSchema = z
  .object(
    Object.fromEntries(
      COLOR_GRADING_ADJUST_KEYS.map((key) => [
        key,
        (key === "exposure" ? number(-2, 2) : signed)
          .optional()
          .describe(ADJUST_DESCRIPTIONS[key]),
      ]),
    ) as Record<
      (typeof COLOR_GRADING_ADJUST_KEYS)[number],
      z.ZodOptional<ReturnType<typeof number>>
    >,
  )
  .strict()
  .describe("Basic correction; 0, or left out, changes nothing");

const curve = z
  .array(z.tuple([unit, unit]))
  .min(2)
  .max(COLOR_GRADING_MAX_CURVE_POINTS)
  .describe(
    "Points [input, output] from 0 to 1 through a smooth monotone curve; [[0,0],[1,1]] is no change, and missing 0 and 1 ends are inferred",
  );
const CurvesSchema = z
  .object(
    Object.fromEntries(
      COLOR_GRADING_CURVE_KEYS.map((key) => [key, curve.optional()]),
    ) as Record<
      (typeof COLOR_GRADING_CURVE_KEYS)[number],
      z.ZodOptional<typeof curve>
    >,
  )
  .strict()
  .describe(
    "Curves: master on every channel, then red, green and blue on their own",
  );

const hue = number(0, 359.9999);
const hueCurve = (range: number, meaning: string) =>
  z
    .array(z.tuple([hue, number(-range, range)]))
    .min(3)
    .max(COLOR_GRADING_MAX_CURVE_POINTS)
    .describe(
      `Points [hue degrees, change] around the colour wheel (0 red, 120 green, 240 blue), ${meaning}; at least three`,
    );
const HueCurvesSchema = z
  .object({
    hueVsHue: hueCurve(
      180,
      "rotating those hues by up to 180 degrees",
    ).optional(),
    hueVsSaturation: hueCurve(
      1,
      "-1 removes their saturation, 1 doubles it",
    ).optional(),
    hueVsLuma: hueCurve(1, "darkening or brightening them").optional(),
  })
  .strict()
  .describe("Hue curves, the HSL secondaries of one hue at a time");

const wheel = z
  .object({
    hue: hue.optional().describe("Direction of the colour push in degrees"),
    amount: unit.optional().describe("How far toward that hue, 0 to 1"),
    level: signed.optional().describe("Brightness of the range, -1 to 1"),
  })
  .strict();
const WheelsSchema = z
  .object(
    Object.fromEntries(
      COLOR_GRADING_WHEEL_KEYS.map((key) => [key, wheel.optional()]),
    ) as Record<
      (typeof COLOR_GRADING_WHEEL_KEYS)[number],
      z.ZodOptional<typeof wheel>
    >,
  )
  .strict()
  .describe(
    "Colour wheels for shadows, midtones and highlights, which blend into each other by brightness. Teal shadows (hue 190) and orange highlights (hue 30) give a teal and orange look",
  );

const softRange = z
  .object({
    min: unit.optional(),
    max: unit.optional(),
    softness: number(0, 0.5).optional(),
  })
  .strict();
const SecondarySchema = z
  .object({
    enabled: z.boolean().optional(),
    key: z
      .object({
        hue: z
          .object({
            center: hue.optional(),
            range: number(0, 180).optional(),
            softness: number(0, 180).optional(),
          })
          .strict()
          .optional(),
        saturation: softRange.optional(),
        luma: softRange.optional(),
      })
      .strict()
      .describe("Which pixels it changes: a hue range, saturation and luma"),
    correction: z
      .object({
        hueShift: number(-180, 180).optional(),
        saturation: signed.optional(),
        luma: signed.optional(),
        temperature: signed.optional(),
        tint: signed.optional(),
      })
      .strict(),
  })
  .strict();

/** A project file, relative to the composition, so the preview and export load the same one. */
export const LutPathSchema = z
  .string()
  .max(500)
  .regex(
    /^(?![a-z][a-z0-9+.-]*:|\/|\\)(?!.*(?:^|\/)\.)[^?#\\\0"'<>]+\.cube$/i,
    "A LUT is a .cube file in the project, named by its project path.",
  );

const LutSchema = z
  .object({
    src: LutPathSchema,
    intensity: unit
      .optional()
      .describe("How much of the LUT shows, 0 to 1; 1 when left out"),
  })
  .strict()
  .describe(
    "A look LUT, applied after every other stage. Import a .cube with lut_import first",
  );

const gradeFields = {
  intensity: unit
    .optional()
    .describe(
      "Mix of the whole grade with the ungraded picture; 1 when left out",
    ),
  adjust: AdjustSchema.optional(),
  wheels: WheelsSchema.optional(),
  curves: CurvesSchema.optional(),
  hueCurves: HueCurvesSchema.optional(),
  secondaries: z
    .array(SecondarySchema)
    .max(COLOR_GRADING_MAX_SECONDARIES)
    .optional()
    .describe(
      "Qualified corrections: each changes only the pixels its key selects",
    ),
  lut: LutSchema.optional(),
};

/** HyperFrames' own contract checks what the shape cannot: duplicate points, min below max. */
const contract = (grade: object, context: z.RefinementCtx) => {
  for (const issue of validateColorGradingContract(grade))
    context.addIssue({
      code: "custom",
      message: `${issue.path ? `${issue.path} ` : ""}${issue.message}`,
    });
};

export const GradeSchema = z
  .object(gradeFields)
  .strict()
  .superRefine(contract)
  .describe(
    "The clip's colour grade, as HyperFrames' data-color-grading draws it in the preview and the export. Sections left out change nothing",
  );
export type Grade = z.infer<typeof GradeSchema>;

export const GradeEditSchema = z
  .object({
    intensity: gradeFields.intensity,
    adjust: AdjustSchema.optional().describe(
      "Basic correction to change; fields left out keep their values, 0 resets one",
    ),
    wheels: WheelsSchema.optional().describe(
      "Wheels to change; a wheel left out keeps its values, and one given replaces that wheel",
    ),
    curves: z
      .object(
        Object.fromEntries(
          COLOR_GRADING_CURVE_KEYS.map((key) => [
            key,
            curve.nullable().optional(),
          ]),
        ) as Record<
          (typeof COLOR_GRADING_CURVE_KEYS)[number],
          z.ZodOptional<z.ZodNullable<typeof curve>>
        >,
      )
      .strict()
      .optional()
      .describe(
        "Curves to replace, each a whole curve; null resets one and a curve left out keeps its points",
      ),
    hueCurves: z
      .object({
        hueVsHue: HueCurvesSchema.shape.hueVsHue.unwrap().nullable().optional(),
        hueVsSaturation: HueCurvesSchema.shape.hueVsSaturation
          .unwrap()
          .nullable()
          .optional(),
        hueVsLuma: HueCurvesSchema.shape.hueVsLuma
          .unwrap()
          .nullable()
          .optional(),
      })
      .strict()
      .optional()
      .describe("Hue curves to replace; null resets one"),
    secondaries: gradeFields.secondaries.describe(
      "Replace every qualified correction; [] removes them",
    ),
    lut: LutSchema.nullable()
      .optional()
      .describe(
        "The look LUT, applied after every other stage; null removes it",
      ),
  })
  .strict()
  .describe(
    "Change the clip's colour grade: fields left out keep their values. Video and image clips only. Check the picture with timeline_view",
  );
export type GradeEdit = z.infer<typeof GradeEditSchema>;

const isZero = (value: number | undefined) => !value;
const isIdentityCurve = (points: readonly (readonly number[])[]) =>
  points.every(([input, output]) => input === output);

/**
 * The grade with nothing that changes the picture left in it, or null when nothing does. Two grades
 * that draw the same compare equal, so an edit back to neutral removes the attribute.
 */
export function tidyGrade(grade: Grade): Grade | null {
  const adjust = Object.fromEntries(
    Object.entries(grade.adjust ?? {}).filter(([, value]) => !isZero(value)),
  );
  const wheels = Object.fromEntries(
    Object.entries(grade.wheels ?? {}).filter(
      ([, wheel]) => wheel && (!isZero(wheel.amount) || !isZero(wheel.level)),
    ),
  );
  const curves = Object.fromEntries(
    Object.entries(grade.curves ?? {}).filter(
      ([, points]) => points && !isIdentityCurve(points),
    ),
  );
  const hueCurves = Object.fromEntries(
    Object.entries(grade.hueCurves ?? {}).filter(
      ([, points]) => points && points.some(([, change]) => change !== 0),
    ),
  );
  const secondaries = (grade.secondaries ?? []).filter(
    (secondary) => secondary.enabled !== false,
  );
  const lut = grade.lut && grade.lut.intensity !== 0 ? grade.lut : undefined;
  const tidy: Grade = {
    ...(grade.intensity !== undefined &&
      grade.intensity !== 1 && { intensity: grade.intensity }),
    ...(Object.keys(adjust).length && { adjust }),
    ...(Object.keys(wheels).length && { wheels }),
    ...(Object.keys(curves).length && { curves }),
    ...(Object.keys(hueCurves).length && { hueCurves }),
    ...(secondaries.length && { secondaries }),
    ...(lut && { lut }),
  };
  const changes =
    tidy.adjust ||
    tidy.wheels ||
    tidy.curves ||
    tidy.hueCurves ||
    tidy.secondaries ||
    tidy.lut;
  return changes && tidy.intensity !== 0 ? tidy : null;
}

/**
 * Applies an edit on top of a grade. The result is checked again, since stages combine; the
 * engine turns a refusal into its own error.
 */
export function editGrade(
  grade: Grade | null,
  edit: GradeEdit,
): { grade: Grade | null } | { refusal: string } {
  const current = grade ?? {};
  const replaced = <T extends object>(
    before: T | undefined,
    changes: { [K in keyof T]?: T[K] | null } | undefined,
  ) =>
    changes === undefined
      ? before
      : (Object.fromEntries(
          Object.entries({ ...before, ...changes }).filter(
            ([, value]) => value !== null && value !== undefined,
          ),
        ) as T);
  const next = {
    ...current,
    ...(edit.intensity !== undefined && { intensity: edit.intensity }),
    adjust: edit.adjust
      ? { ...current.adjust, ...edit.adjust }
      : current.adjust,
    wheels: edit.wheels
      ? { ...current.wheels, ...edit.wheels }
      : current.wheels,
    curves: replaced(current.curves, edit.curves),
    hueCurves: replaced(current.hueCurves, edit.hueCurves),
    secondaries: edit.secondaries ?? current.secondaries,
    lut: edit.lut === undefined ? current.lut : (edit.lut ?? undefined),
  };
  const checked = GradeSchema.safeParse(next);
  if (!checked.success)
    return {
      refusal: `That grade is out of range: ${checked.error.issues.map((issue) => issue.message).join("; ")}.`,
    };
  return { grade: tidyGrade(checked.data) };
}

/** The attribute that draws a grade: compact JSON, or null for none. */
export const writeGrade = (grade: Grade | null) =>
  grade && tidyGrade(grade) ? JSON.stringify(tidyGrade(grade)) : null;

/**
 * The grade an authored `data-color-grading` holds, or why Cutroom cannot edit it: a stage it has
 * no control for (a preset, grain, an effect, a variable), or a value HyperFrames would refuse.
 */
export function readGrade(
  attribute: string | undefined,
): { grade: Grade | null } | { restriction: string } {
  if (attribute === undefined || !attribute.trim()) return { grade: null };
  let raw: unknown;
  try {
    raw = JSON.parse(attribute);
  } catch {
    return {
      restriction:
        "Its data-color-grading is not JSON. Repair it in the source first.",
    };
  }
  const parsed = GradeSchema.safeParse(raw);
  if (parsed.success) return { grade: tidyGrade(parsed.data) };
  return {
    restriction: `Its data-color-grading uses ${parsed.error.issues
      .slice(0, 2)
      .map((issue) => issue.path.join(".") || issue.message)
      .join(" and ")}, which Cutroom does not edit. Edit it in the source.`,
  };
}

export const LutImportSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .describe(
      "Full path of a .cube 3D LUT on this computer, up to 65 points per axis and 16 MB. It is checked and copied into the project's luts folder",
    ),
});

export const GradeLutSaveSchema = z.object({
  composition: z.string().default("index.html"),
  clipId: z.string().min(1),
  size: z
    .union([z.literal(33), z.literal(65)])
    .default(33)
    .describe("Points per axis: 33 is the common size, 65 the most exact"),
  name: z
    .string()
    .max(60)
    .optional()
    .describe(
      "The LUT's title and file name; the clip's name and grade when left out",
    ),
});

/** A LUT in the project, as the server lists and imports it. */
export const LutInfoSchema = z.object({
  path: z.string(),
  title: z.string().nullable(),
  size: z.number().int(),
});
export type LutInfo = z.infer<typeof LutInfoSchema>;

/** Pictures own a grade. An adjustment grades the composited tracks beneath it. */
export function canHaveGrade({
  kind,
  adjustment,
}: Pick<Clip, "kind" | "adjustment">) {
  return adjustment || kind === "video" || kind === "image";
}

export const takesGrade = (clip: Clip) =>
  canHaveGrade(clip) && !clip.sourceRestrictions?.grade;
