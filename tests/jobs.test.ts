import { expect, test } from "bun:test";
import { createJobMachine } from "../src/shared/jobs";

test("jobs reject skipped and terminal transitions and validate progress", () => {
  const job = createJobMachine();
  expect(() => job.transition({ status: "done", progress: 1 })).toThrow(
    "queued > done",
  );
  job.transition({ status: "running", progress: 0 });
  job.transition({ status: "running", progress: 0.5 });
  expect(() => job.transition({ status: "running", progress: 2 })).toThrow();
  expect(job.state).toEqual({ status: "running", progress: 0.5 });
  job.transition({ status: "done", progress: 1 });
  expect(() => job.transition({ status: "running", progress: 0 })).toThrow(
    "done > running",
  );
});

test("cancellation settles only after cleanup and cannot complete or fail late", () => {
  for (const start of ["queued", "running"] as const) {
    const job = createJobMachine();
    if (start === "running")
      job.transition({ status: "running", progress: 0.3 });
    job.transition({ status: "cancelling", progress: job.state.progress });
    expect(() => job.transition({ status: "done", progress: 1 })).toThrow();
    expect(() =>
      job.transition({ status: "failed", progress: 0, error: "late" }),
    ).toThrow();
    job.transition({ status: "cancelled", progress: job.state.progress });
    expect(() => job.transition({ status: "running", progress: 0 })).toThrow();
  }
});
