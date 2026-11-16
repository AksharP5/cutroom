import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleFontAddSchema } from "../../shared/fonts";

export function registerFontTools(
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
    "fonts_list",
    {
      description:
        "List the font families the project declares in index.html, and Google Fonts families whose name contains query (most popular first, up to limit) with the weights each offers. Reads Google's public catalogue; nothing from the project is sent.",
      inputSchema: {
        projectId,
        query: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    ({ projectId: id, query, limit }) => {
      const search = new URLSearchParams({
        ...(query !== undefined && { query }),
        ...(limit !== undefined && { limit: String(limit) }),
      });
      return request(`${project(id)}/fonts?${search}`);
    },
  );
  server.registerTool(
    "fonts_add",
    {
      description:
        "Download a Google Fonts family into the project, one TrueType file per weight in assets/fonts, and declare it with @font-face in index.html, as one undo step. Preview and export then use the local files, offline. Afterwards the family is in timeline.fonts, so title.font and setClip.style.fontFamily accept it. Weights already added are skipped; a family index.html already declares by hand is refused.",
      inputSchema: { projectId, ...GoogleFontAddSchema.shape },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    ({ projectId: id, ...input }) =>
      request(`${project(id)}/fonts/google`, "POST", input),
  );
}
