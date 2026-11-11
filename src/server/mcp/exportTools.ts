import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ExportStartSchema } from "../../shared/export";

export function registerExportTools(
  server: Pick<McpServer, "registerTool">,
  request: (
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<CallToolResult>,
) {
  const job = {
    jobId: z.string().describe("Job ID returned by export_start or the editor"),
  };
  const edit = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  };
  server.registerTool(
    "export_start",
    {
      description:
        "Export MP4 through the editor's render jobs. Defaults to In to Out when both marks exist, otherwise the whole timeline, Standard quality, and the next free project name in .cutroom/renders. Explicit frame ranges are half-open. A chosen directory must be an absolute existing folder. Never overwrites a file. Only one export can run at a time across all projects and clients. If one is running, wait for it or use export_cancel with its jobId before starting another.",
      inputSchema: ExportStartSchema.extend({ projectId: z.string() }),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(
        `/projects/${encodeURIComponent(projectId)}/export`,
        "POST",
        input,
      ),
  );
  server.registerTool(
    "export_status",
    {
      description:
        "Read any editor or agent export job's status, stage, progress percent, current-stage time estimate, output path, finished byte size, and failure cause. An estimate is null until enough frames have been measured.",
      inputSchema: job,
      annotations: { ...edit, readOnlyHint: true },
    },
    ({ jobId }) => request(`/render/${encodeURIComponent(jobId)}`),
  );
  server.registerTool(
    "export_cancel",
    {
      description:
        "Cancel an editor or agent export and wait for worker and partial-file cleanup. A file already published stays complete. Cleanup failures are reported, never hidden as successful cancellation. Once cleanup finishes, another export can start.",
      inputSchema: job,
      annotations: edit,
    },
    ({ jobId }) =>
      request(`/render/${encodeURIComponent(jobId)}/cancel`, "POST"),
  );
}
