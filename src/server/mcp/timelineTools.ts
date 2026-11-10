import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { frameTime } from "../../shared/timeline/apply";
import {
  CommandBatchSchema,
  TimelineViewSchema,
} from "../../shared/timeline/schema";

type JsonRequest = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<CallToolResult>;
/** Fetches a path on the local server, such as `/api/projects/...`. */
type LocalFetch = (path: string) => Promise<Response>;

const input = {
  projectId: z.string().describe("Project ID returned by projects_list"),
  composition: z
    .string()
    .default("index.html")
    .describe("Composition file within the project"),
};
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

export function registerTimelineTools(
  server: Pick<McpServer, "registerTool">,
  request: JsonRequest,
  fetchLocal: LocalFetch,
) {
  const id = encodeURIComponent;
  const timelinePath = (projectId: string, composition: string) =>
    `/projects/${id(projectId)}/timeline?composition=${id(composition)}`;
  server.registerTool(
    "timeline_read",
    {
      description:
        "Read the timeline: tracks, clips, markers, and in/out range in integer frames at the composition's fps, plus the revision to pass to timeline_edit.",
      inputSchema: input,
      annotations: readOnly,
    },
    ({ projectId, composition }) =>
      request(timelinePath(projectId, composition)),
  );
  server.registerTool(
    "timeline_edit",
    {
      description:
        "Apply a batch of timeline commands as one undo step. Linked clips edit together, ripple edits follow unlocked auto-select tracks, and a command that cannot apply exactly fails the whole batch. Pass the revision from timeline_read; the response carries the next one.",
      inputSchema: CommandBatchSchema.extend({ projectId: input.projectId }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId, ...batch }) =>
      request(`/projects/${id(projectId)}/commands`, "POST", batch),
  );
  server.registerTool(
    "timeline_view",
    {
      description: "Render one timeline frame as an image.",
      inputSchema: { ...input, frame: z.number().int().nonnegative() },
      annotations: readOnly,
    },
    async ({ projectId, composition, frame }): Promise<CallToolResult> => {
      const failed = (text: string): CallToolResult => ({
        content: [{ type: "text", text }],
        isError: true,
      });
      const read = await fetchLocal(
        `/api/cutroom${timelinePath(projectId, composition)}`,
      );
      if (!read.ok)
        return failed(`Cutroom returned ${read.status}: ${await read.text()}`);
      const { timeline } = TimelineViewSchema.parse(await read.json());
      // Full precision: the renderer floors seek times onto frames.
      const seconds = frameTime(frame, timeline.fps);
      const image = await fetchLocal(
        `/api/projects/${id(projectId)}/thumbnail/${composition.split("/").map(id).join("/")}?t=${seconds}&format=jpeg&output=source`,
      );
      if (!image.ok)
        return failed(
          `Cutroom returned ${image.status}: ${await image.text()}`,
        );
      return {
        content: [
          {
            type: "image",
            data: Buffer.from(await image.arrayBuffer()).toString("base64"),
            mimeType: "image/jpeg",
          },
          { type: "text", text: `Frame ${frame} (${seconds.toFixed(3)}s)` },
        ],
      };
    },
  );
}
