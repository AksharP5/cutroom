import { z } from "zod";
import {
  createConsoleLogger,
  createRenderJob,
  executeRenderJob,
  parseRenderRequest,
  renderConfigFromRequest,
  resolveConfig,
} from "@hyperframes/producer";

const Input = z.object({
  projectDir: z.string(),
  outputPath: z.string(),
  options: z.record(z.string(), z.unknown()),
});
const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
process.once("SIGINT", () => abort.abort());
const send = (event: unknown) =>
  process.stdout.write(`CUTROOM_RENDER:${JSON.stringify(event)}\n`);

try {
  process.stdin.setEncoding("utf8");
  let body = "";
  for await (const chunk of process.stdin)
    body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const input = Input.parse(JSON.parse(body));
  const request = parseRenderRequest({
    version: 1,
    ...input,
    options: { ...input.options, engineConfig: resolveConfig() },
  });
  const job = createRenderJob(
    renderConfigFromRequest(request, { logger: createConsoleLogger("warn") }),
  );
  await executeRenderJob(
    job,
    request.projectDir,
    request.outputPath,
    (progress) => {
      send({
        type: "progress",
        progress: progress.progress,
        stage: progress.currentStage,
      });
    },
    abort.signal,
  );
  send({ type: "complete", audioLoweredDb: job.audioLoweredDb });
} catch (error) {
  send({
    type: "error",
    cancelled: abort.signal.aborted,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
