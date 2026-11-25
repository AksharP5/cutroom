import { randomUUID } from "node:crypto";
import { HttpError } from "../../shared/errors";
import type { ResolveExport, ResolveExportJob } from "../../shared/export";

type ResolveJob = {
  state: ResolveExportJob;
  composition: string;
  done: Promise<ResolveExport>;
  cancel: () => Promise<void>;
};

type ResolveJobControl = {
  jobId: string;
  signal: AbortSignal;
  update: (stage: string, progress: number) => void;
};

export function createResolveJobs() {
  const jobs = new Map<string, ResolveJob>();
  let running: ResolveJob | undefined;
  let closing = false;
  const prune = () => {
    for (const [id, { state }] of jobs) {
      if (state.finishedAt !== null && Date.now() - state.finishedAt > 300_000)
        jobs.delete(id);
    }
  };
  return {
    active: () => running,
    get(jobId: string) {
      prune();
      return jobs.get(jobId);
    },
    start(
      projectId: string,
      composition: string,
      name: string,
      exportPackage: (control: ResolveJobControl) => Promise<ResolveExport>,
    ) {
      if (closing) throw new HttpError(503, "The renderer is shutting down.");
      prune();
      const cancel = new AbortController();
      const state: ResolveExportJob = {
        jobId: randomUUID(),
        projectId,
        name,
        format: "resolve",
        status: "rendering",
        stage: "Preparing Resolve export",
        progress: 0,
        outputPath: null,
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
      };
      const done = (async () => {
        // Acknowledging admission does not wait for source probing, copying, or rendering.
        await Bun.sleep(0);
        try {
          const result = await exportPackage({
            jobId: state.jobId,
            signal: cancel.signal,
            update(stage, progress) {
              state.stage = stage;
              state.progress = Math.max(state.progress, progress);
            },
          });
          state.status = "complete";
          state.stage = "Ready for Resolve";
          state.progress = 100;
          state.outputPath = result.outputPath;
          state.result = result;
          return result;
        } catch (error) {
          if (error === cancel.signal.reason) {
            state.status = "cancelled";
            state.stage = "Cancelled";
          } else {
            state.status = "failed";
            state.error =
              error instanceof Error ? error.message : String(error);
          }
          throw error;
        } finally {
          state.finishedAt = Date.now();
          running = undefined;
        }
      })();
      // MCP callers poll state. The dialog still awaits the same job's final package.
      void done.catch(() => {});
      const job: ResolveJob = {
        state,
        composition,
        done,
        async cancel() {
          cancel.abort();
          await done.catch(() => {});
        },
      };
      jobs.set(state.jobId, job);
      running = job;
      return job;
    },
    async close() {
      closing = true;
      await running?.cancel();
    },
  };
}
