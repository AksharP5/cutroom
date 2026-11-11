import { z } from "zod";
import { FpsSchema } from "./schema.ts";

export const PositionSupportSchema = z.object({
  reason: z.string().nullable(),
});

/** Private IPC boundary between the Bun server and the producer's Node worker. */
export const PositionCheckSchema = z.object({
  projectDir: z.string(),
  composition: z.string(),
  overrides: z.record(z.string(), z.string()).default({}),
  sources: z.tuple([z.string(), z.string()]),
  clipId: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  fps: FpsSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type PositionCheck = z.infer<typeof PositionCheckSchema>;

export function positionCheckFrames(start: number, end: number) {
  const count = end - start;
  if (count <= 150) return Array.from({ length: count }, (_, i) => start + i);
  // Bound long-clip latency: 150 evenly spaced interior frames plus both ends.
  // A conflict that appears and disappears entirely between samples can be missed.
  return [
    start,
    ...Array.from(
      { length: 150 },
      (_, i) => start + Math.round(((i + 1) * (count - 1)) / 151),
    ),
    end - 1,
  ];
}
