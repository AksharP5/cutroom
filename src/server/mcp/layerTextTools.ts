import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  LayerTextQuerySchema,
  LayerTextSnapshotSchema,
  LayerTextUpdateSchema,
} from "../../shared/layerText";

export function registerLayerTextTools(
  server: Pick<McpServer, "registerTool">,
  request: (
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<CallToolResult>,
) {
  const projectId = z.string().describe("Project ID returned by projects_list");
  const path = (id: string) => `/projects/${encodeURIComponent(id)}/layer-text`;
  const outputSchema = { result: LayerTextSnapshotSchema };
  server.registerTool(
    "layer_text_list",
    {
      description:
        "List the authored text layers inside one timed graphic, their IDs and source-only reasons, and the exact version required by layer_text_update. Use the containing timeline's HTML composition and clip ID.",
      inputSchema: LayerTextQuerySchema.extend({ projectId }),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId, ...input }) =>
      request(`${path(projectId)}?${new URLSearchParams(input)}`),
  );
  server.registerTool(
    "layer_text_update",
    {
      description:
        "Replace one existing plain-text child layer's words as one editor Undo step. Use the layerId and expectedVersion from layer_text_list. The parent clip must be unlocked. Newlines become line breaks. Read again after a conflict.",
      inputSchema: LayerTextUpdateSchema.extend({ projectId }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId, ...input }) => request(path(projectId), "POST", input),
  );
}
