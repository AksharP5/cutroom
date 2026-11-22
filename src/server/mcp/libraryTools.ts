import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LibraryAddSchema, LibrarySearchSchema } from "../../shared/library";

export function registerLibraryTools(
  server: Pick<McpServer, "registerTool">,
  request: (
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<CallToolResult>,
) {
  const projectId = z.string().describe("Project ID returned by projects_list");
  const library = (id: string) => `/projects/${encodeURIComponent(id)}/library`;
  server.registerTool(
    "library_search",
    {
      description:
        "Search the HyperFrames library: blocks (scenes with their own length, such as lower thirds, transitions, title cards and charts) and components (effects and text treatments, 3 seconds once added), at the registry tag matching Cutroom's HyperFrames. Returns name, title, kind, duration in seconds for blocks, category, description, tags, variables with defaults, and inProject. Reads HyperFrames' public registry; nothing from the project is sent.",
      inputSchema: { projectId, ...LibrarySearchSchema.shape },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    ({ projectId: id, query, category, limit }) => {
      const search = new URLSearchParams({
        ...(query !== undefined && { query }),
        ...(category !== undefined && { category }),
        ...(limit !== undefined && { limit: String(limit) }),
      });
      return request(`${library(id)}?${search}`);
    },
  );
  server.registerTool(
    "library_add",
    {
      description:
        "Add a HyperFrames library item to a timeline as a scene clip, as one undo step: copies its files into the project (compositions/ and its assets; unchanged files already there are reused, an edited copy of its scene is kept and the new one goes in as name-2.html), records its license and source in cutroom.json, places the clip and sets its variables. Returns the clip id and the files added. Prefer this to copying registry HTML with source_write, so the license record and the undo step stay right.",
      inputSchema: { projectId, ...LibraryAddSchema.shape },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    ({ projectId: id, ...input }) => request(library(id), "POST", input),
  );
}
