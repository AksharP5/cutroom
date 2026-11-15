import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { join } from "node:path";
import { ExportStartSchema } from "../../shared/export";

const DefaultsSchema = z.object({
  result: z.object({ directory: z.string(), filename: z.string() }),
});

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
        "Export MP4 through the editor's render jobs. Defaults to In to Out when both marks exist, otherwise the whole timeline, Standard quality, and the next free project name in .cutroom/renders. Explicit frame ranges are half-open. A chosen directory must be an absolute existing folder. A filename that already exists in the folder is refused before the export starts. Only one export can run at a time across all projects and clients. If one is running, wait for it or use export_cancel with its jobId before starting another.",
      inputSchema: ExportStartSchema.extend({ projectId: z.string() }),
      annotations: edit,
    },
    async ({ projectId, ...input }) => {
      const project = encodeURIComponent(projectId);
      if (input.filename) {
        // A taken name otherwise starts a job that only fails when it publishes.
        const query = new URLSearchParams({
          filename: input.filename,
          ...(input.directory && { directory: input.directory }),
        });
        const checked = await request(
          `/cutroom/projects/${project}/export-defaults?${query}`,
        );
        if (checked.isError) return checked;
        const { directory, filename } = DefaultsSchema.parse(
          checked.structuredContent,
        ).result;
        if (filename !== input.filename)
          return {
            content: [
              {
                type: "text",
                text: `${join(directory, input.filename)} already exists. Exports never overwrite a file; choose another filename, such as "${filename}".`,
              },
            ],
            isError: true,
          };
      }
      return request(`/projects/${project}/export`, "POST", input);
    },
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
