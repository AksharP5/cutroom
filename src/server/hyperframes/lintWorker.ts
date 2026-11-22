import { parentPort } from "node:worker_threads";
import { lintHyperframeHtml, lintProject } from "@hyperframes/core/lint";

export type LintTask =
  | { task: "project"; args: Parameters<typeof lintProject> }
  | { task: "html"; args: Parameters<typeof lintHyperframeHtml> };
export type LintRequest = LintTask & { id: number };

parentPort?.on("message", async (request: LintRequest) => {
  try {
    const result = await (request.task === "project"
      ? lintProject(...request.args)
      : lintHyperframeHtml(...request.args));
    parentPort!.postMessage({ id: request.id, result });
  } catch (error) {
    parentPort!.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
