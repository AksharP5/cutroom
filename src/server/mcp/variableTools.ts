import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  VariableDeclareSchema,
  VariableDefaultSchema,
  VariablesPreviewSchema,
} from "../../shared/variables";

export function registerVariableTools(
  server: Pick<McpServer, "registerTool">,
  request: (
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<CallToolResult>,
) {
  const projectId = z.string().describe("Project ID returned by projects_list");
  const variables = (id: string) =>
    `/projects/${encodeURIComponent(id)}/variables`;
  const edit = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  };
  server.registerTool(
    "variables_list",
    {
      description:
        "List a composition's HyperFrames variables (data-composition-variables): each declaration's id, type, label, default and options, and preview, the overrides the editor's viewer shows now. Overrides never change the source; export_start renders them only when passed as its variables.",
      inputSchema: {
        projectId,
        composition: VariablesPreviewSchema.shape.composition,
      },
      annotations: { ...edit, readOnlyHint: true },
    },
    ({ projectId, composition }) =>
      request(
        `${variables(projectId)}?${new URLSearchParams({ composition })}`,
      ),
  );
  server.registerTool(
    "variables_preview",
    {
      description:
        "Replace the overrides the editor's viewer previews for a composition, as hyperframes render --variables would apply them, without writing the source or history. Strings, numbers, hex colours, booleans and enum options are checked against each declaration; font and image variables are set in the source. timeline_view still shows the defaults.",
      inputSchema: VariablesPreviewSchema.extend({ projectId }),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`${variables(projectId)}/preview`, "PUT", input),
  );
  server.registerTool(
    "variables_set_default",
    {
      description:
        "Make a value a variable's declared default in the source, as one undo step, and drop its preview override.",
      inputSchema: VariableDefaultSchema.extend({ projectId }),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`${variables(projectId)}/default`, "POST", input),
  );
  server.registerTool(
    "variables_declare",
    {
      description:
        "Declare a new string, number, color, boolean or enum variable on a composition, and optionally bind it to a text element clip that has an id: text makes the variable its words (data-var-text), color its text colour (color: var(--id)). The default should match what the element shows so nothing changes until a value is set. One undo step. Titles keep their words and colour in their own settings, so they cannot be bound.",
      inputSchema: VariableDeclareSchema.extend({ projectId }),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`${variables(projectId)}/declare`, "POST", input),
  );
}
