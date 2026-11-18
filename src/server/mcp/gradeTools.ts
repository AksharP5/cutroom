import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  GradeLutSaveSchema,
  LutImportSchema,
} from "../../shared/timeline/grade";

export function registerGradeTools(
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
    "luts_list",
    {
      description:
        "List the .cube LUTs in the project's luts folder, with their titles and sizes. Use one as a look with setClip.grade.lut {src: path}.",
      inputSchema: { projectId },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId: id }) => request(`${project(id)}/luts`),
  );
  server.registerTool(
    "lut_import",
    {
      description:
        "Copy a .cube 3D LUT from this computer into the project's luts folder, after checking it: up to 65 points per axis and 16 MB, every value a finite number. Returns its project path for setClip.grade.lut. It reads a file outside the project, so it always asks.",
      inputSchema: { projectId, ...LutImportSchema.shape },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId: id, ...input }) =>
      request(`${project(id)}/luts`, "POST", input),
  );
  server.registerTool(
    "grade_save_lut",
    {
      description:
        "Bake a clip's whole grade into a .cube LUT in the project's luts folder, matching the preview: for the same look on other clips, or for DaVinci Resolve and other editors. Returns its project path.",
      inputSchema: { projectId, ...GradeLutSaveSchema.shape },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId: id, ...input }) =>
      request(`${project(id)}/grade/lut`, "POST", input),
  );
}
