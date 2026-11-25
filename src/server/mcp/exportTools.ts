import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { join } from "node:path";
import {
  ExportStartSchema,
  StillFrameRequestSchema,
} from "../../shared/export";

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
        "Start an MP4, MOV, WebM, GIF, or DaVinci Resolve export and return a jobId to poll with export_status. Resolve writes the whole timeline as FCPXML, rendered ProRes layers, marker EDL, and Summary.txt. Set copyMedia to include copies. Omit filename for Resolve. For other formats the defaults are marked In to Out when both exist, otherwise the whole timeline, Standard quality, composition size and rate, and the next free project name in .cutroom/renders. Explicit ranges are half-open. Choose an absolute existing directory. Only one export can run across all projects and clients.",
      inputSchema: ExportStartSchema.extend({ projectId: z.string() }),
      annotations: edit,
    },
    async ({ projectId, ...input }) => {
      const project = encodeURIComponent(projectId);
      if (input.filename && input.format !== "resolve") {
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
      const path = `/projects/${project}/export`;
      return request(
        input.format === "resolve" ? `${path}?background=1` : path,
        "POST",
        input,
      );
    },
  );
  server.registerTool(
    "export_frame",
    {
      description:
        "Save a zero-based composition frame as a full-size PNG in .cutroom/renders using the editor's Save Frame capture. Omit composition for index.html. Returns the absolute path and filename. Captures saved source and declared defaults. Existing files are kept.",
      inputSchema: StillFrameRequestSchema.extend({ projectId: z.string() }),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(
        `/projects/${encodeURIComponent(projectId)}/still`,
        "POST",
        input,
      ),
  );
  server.registerTool(
    "export_status",
    {
      description:
        "Poll the jobId from export_start for status, stage, progress from 0 to 100, failure cause, and final outputPath. A completed Resolve job also returns result with its package files and notes. Video jobs include byte size and estimated time for stages with enough frames measured.",
      inputSchema: job,
      annotations: { ...edit, readOnlyHint: true },
    },
    ({ jobId }) => request(`/render/${encodeURIComponent(jobId)}`),
  );
  server.registerTool(
    "export_list",
    {
      description:
        "List the project's finished renders, newest first: every export in its .cutroom/renders and the ones the editor or an agent saved to other folders, while each file is still the one Cutroom wrote. Each has its absolute path, format, byte size and modified time in milliseconds.",
      inputSchema: { projectId: z.string() },
      annotations: { ...edit, readOnlyHint: true },
    },
    ({ projectId }) =>
      request(`/projects/${encodeURIComponent(projectId)}/exports`),
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
