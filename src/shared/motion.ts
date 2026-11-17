import { z } from "zod";

export const MotionReadSchema = z.object({
  composition: z.string().default("index.html"),
  clipId: z.string().min(1),
});

export const MotionChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("property"),
      side: z.enum(["from", "to"]),
      name: z.string().min(1),
      value: z.number(),
    })
    .strict(),
  z
    .object({ kind: z.literal("position"), value: z.number().nonnegative() })
    .strict(),
  z
    .object({ kind: z.literal("duration"), value: z.number().nonnegative() })
    .strict(),
  z
    .object({ kind: z.literal("ease"), value: z.string().min(1).max(120) })
    .strict(),
]);

export const MotionUpdateSchema = MotionReadSchema.extend({
  expectedVersion: z.string().min(1),
  animationId: z.string().min(1),
  change: MotionChangeSchema,
}).strict();

export const MotionSnapshotSchema = MotionReadSchema.extend({
  version: z.string(),
  reason: z.string().nullable(),
  notices: z.array(z.string()),
  animations: z.array(
    z.object({
      id: z.string(),
      selector: z.string(),
      method: z.enum(["to", "from", "fromTo", "set"]),
      targets: z.array(z.string()),
      reason: z.string().nullable(),
      from: z.record(z.string(), z.number()),
      to: z.record(z.string(), z.number()),
      position: z.number().nullable(),
      duration: z.number().nullable(),
      ease: z.string().nullable(),
      sourceOnly: z.array(z.string()),
    }),
  ),
});

export type MotionSnapshot = z.infer<typeof MotionSnapshotSchema>;
export type MotionChange = z.infer<typeof MotionChangeSchema>;
export type MotionUpdate = z.infer<typeof MotionUpdateSchema>;
