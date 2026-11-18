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
        "Export through the editor's render jobs, of the root composition or one named by composition: MP4 (H.264), MOV (ProRes 4444 with alpha), WebM (VP9 with alpha) or GIF. The format resolve renders nothing: it writes a new folder for DaVinci Resolve with the whole timeline as FCPXML linked to the original media (tracks, cuts, speed, V1 transitions, transforms, crops, opacity and keyframes, region zooms, volume), its markers as an EDL, and Summary.txt listing what Resolve can't show; the answer lists the files and those notes, and copyMedia copies the media in. Areas nothing draws stay transparent in MOV, WebM and GIF, so hide a full-frame background for an overlay. Defaults to In to Out when both marks exist, otherwise the whole timeline, Standard quality, the composition's size and rate, and the next free project name in .cutroom/renders with the format's extension. Explicit frame ranges are half-open. A chosen directory must be an absolute existing folder. A filename that already exists in the folder is refused before the export starts. Only one export can run at a time across all projects and clients. If one is running, wait for it or use export_cancel with its jobId before starting another.",
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
        "Read any editor or agent export job's status, stage, progress percent, current-stage time estimate, output path, finished byte size, and failure cause. An estimate is null until enough frames have been measured.",
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
