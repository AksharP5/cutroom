import { z } from "zod";

/** Where each timeline clip's element starts in its composition's source, as a character offset. */
export const ClipSourcesSchema = z.object({
  composition: z.string(),
  /** The source version the offsets were read from. */
  version: z.string(),
  clips: z.record(z.string(), z.number().int().nonnegative()),
});
