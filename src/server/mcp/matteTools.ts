import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { matteModelSize } from "../../shared/matte";

export function registerMatteTools(
  server: Pick<McpServer, "registerTool">,
  request: (
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<CallToolResult>,
) {
  const projectId = z.string().describe("Project ID returned by projects_list");
  const project = (id: string) => `/projects/${encodeURIComponent(id)}`;
  server.registerTool(
    "matte_status",
    {
      description:
        "Background removal in a project: model is ready, missing (with bytes), downloading (progress) or failed; jobs lists every matte job with src, the source frames it covers (first, frames), done, status (waiting, running, needs-model, done, stopped, failed with error, no-subject) and elapsed seconds; clips gives each video clip of the composition its background as timeline_read does. Set a clip's background with timeline_edit setClip.background; its job runs after the edit. Poll this, as export_status, before a render that needs the cutout; an export waits for missing mattes by itself.",
      inputSchema: {
        projectId,
        composition: z
          .string()
          .default("index.html")
          .describe("Composition file within the project"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId: id, composition }) =>
      request(
        `${project(id)}/mattes?composition=${encodeURIComponent(composition)}`,
      ),
  );
  server.registerTool(
    "matte_cancel",
    {
      description:
        "Stop a matte job by its id from matte_status. The frames already made are kept, so asking again makes only the rest. The clip keeps background.mode remove; set it to keep with setClip if the owner wanted the background back.",
      inputSchema: { projectId, jobId: z.string().min(1).max(200) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId: id, jobId }) =>
      request(`${project(id)}/mattes/${encodeURIComponent(jobId)}`, "DELETE"),
  );
  server.registerTool(
    "matte_download",
    {
      description: `Download the background removal model (u2net_human_seg, ${matteModelSize}) into HyperFrames' cache, where hyperframes remove-background also reads it. Needed once, when matte_status says the model is missing. It fetches a file from the internet, so it always asks. Returns at once; matte_status reports the progress, and waiting jobs start when it is done.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    () => request("/mattes/model", "POST"),
  );
}
