import { z } from "zod";

const progress = z.number().finite().min(0).max(1);
export const JobStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued"), progress: z.literal(0) }),
  z.object({ status: z.literal("running"), progress }),
  z.object({ status: z.literal("done"), progress: z.literal(1) }),
  z.object({ status: z.literal("failed"), progress, error: z.string() }),
  z.object({ status: z.literal("cancelling"), progress }),
  z.object({ status: z.literal("cancelled"), progress }),
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const jobTransitions = {
  queued: ["running", "cancelling"],
  running: ["running", "done", "failed", "cancelling"],
  done: [],
  failed: [],
  cancelling: ["cancelled"],
  cancelled: [],
} satisfies Record<JobState["status"], readonly JobState["status"][]>;

export function createJobMachine() {
  let state: JobState = { status: "queued", progress: 0 };
  return {
    get state(): Readonly<JobState> {
      return state;
    },
    transition(next: JobState) {
      const allowed: readonly JobState["status"][] =
        jobTransitions[state.status];
      if (!allowed.includes(next.status))
        throw new Error(
          `Illegal job transition: ${state.status} > ${next.status}`,
        );
      state = Object.freeze(JobStateSchema.parse(next));
      return state;
    },
  };
}
