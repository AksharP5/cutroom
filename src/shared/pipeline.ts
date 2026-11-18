import { z } from "zod";

/**
 * Which of a composition's clips the footage pipeline may draw in the viewer, as the server's
 * classifier proved them. Everything else stays with HyperFrames, which draws it on top.
 */
export const PipelinePlanSchema = z.union([
  z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** Video clips the pipeline draws, by timeline clip id, with each one's object-fit. */
    drawable: z.record(z.string(), z.enum(["fill", "contain", "cover"])),
    /** Video clips HyperFrames draws above the pipeline's, with the reason the pipeline cannot. */
    hyperframes: z.record(z.string(), z.string()),
    /** Every visual clip in document order, which breaks ties between clips on one level. */
    order: z.array(z.string()),
    /** Native layers whose authored times can differ from their projected whole frames. */
    fractional: z.array(z.string()),
    /** Stacking level of each track that Cutroom's track layer orders. */
    trackZ: z.record(z.string(), z.number().int()),
    /** The one colour beneath every clip, or null when the page paints none. */
    background: z
      .string()
      .regex(/^#[0-9a-f]{6}$/)
      .nullable(),
  }),
  z.object({
    reason: z.string(),
    hyperframes: z.record(z.string(), z.string()).optional(),
  }),
]);
export type PipelinePlan = z.infer<typeof PipelinePlanSchema>;

export const PipelineResponseSchema = z.object({
  /** The entry composition's source version the plan was read from. */
  revision: z.string(),
  plan: PipelinePlanSchema,
});
