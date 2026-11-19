import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MotionAddFadeSchema,
  MotionReadSchema,
  MotionUpdateSchema,
} from "../../shared/motion";

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
        "Inspect a clip's inline GSAP motion. Returns authored literals, actual selector targets, source-only reasons, and the exact source version required by motion_update and motion_add_fade. fadeReason is null when this clip can take a new fade. Composition is an HTML file, including an external scene.",
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
  server.registerTool(
    "motion_add_fade",
    {
      description:
        "Add a GSAP fade-in to a visual clip at a scene frame. Read the clip with motion_read first and pass its exact expectedVersion. The fade lasts up to half a second within the clip and is one shared Undo step. Use the original file for an external scene with one supported registered inline GSAP timeline, explicit nonnegative tween starts and delays, and no nested scenes. The clip needs a unique authored id and no existing tween or keyed opacity.",
      inputSchema: MotionAddFadeSchema.extend({ projectId }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId, ...input }) => request(path(projectId), "POST", input),
  );
}
