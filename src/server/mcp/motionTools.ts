import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MotionReadSchema, MotionUpdateSchema } from "../../shared/motion";

export function registerMotionTools(
  server: Pick<McpServer, "registerTool">,
  request: (
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<CallToolResult>,
) {
  const projectId = z.string().describe("Project ID returned by projects_list");
  const path = (id: string) => `/projects/${encodeURIComponent(id)}/motion`;
  server.registerTool(
    "motion_read",
    {
      description:
        "Inspect an existing clip's inline GSAP motion. Returns literal numeric from/to properties, authored numeric timing and string ease, actual selector targets, source-only reasons, and the exact source version required by motion_update. Composition is an HTML file, including an external subcomposition. External JS stays source-only.",
      inputSchema: MotionReadSchema.extend({ projectId }),
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
    "motion_update",
    {
      description:
        "Change one existing literal field from motion_read, preserving all other source bytes, as one editor Undo step. Requires that snapshot's exact version and animationId. Shared selectors edit all listed targets. Computed/helper/loop/ambiguous timelines are refused; no adding, deleting or unrolling motion. On conflict, inspect again instead of reusing an ID.",
      inputSchema: MotionUpdateSchema.extend({ projectId }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId, ...input }) => request(path(projectId), "POST", input),
  );
}
