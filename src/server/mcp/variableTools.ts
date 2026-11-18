import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  VariableDeclareSchema,
  VariableBindSchema,
  VariableDefaultSchema,
  VariablesPreviewSchema,
  SceneVariablesQuerySchema,
  SceneVariableUpdateSchema,
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
    "variables_instance_read",
    {
      description:
        "Read the declared defaults and saved overrides on one mounted scene clip. Use the containing timeline's composition and clip ID. Image values are paths relative to the project root. The version covers the slot and its scene source.",
      inputSchema: SceneVariablesQuerySchema.extend({ projectId }),
      annotations: { ...edit, readOnlyHint: true },
    },
    ({ projectId, composition, clipId }) =>
      request(
        `${variables(projectId)}/instance?${new URLSearchParams({ composition, clipId })}`,
      ),
  );
  server.registerTool(
    "variables_instance_set",
    {
      description:
        "Set one saved override on a mounted scene clip, as one undo step. The scene file and other mounts keep their values. Pass null to inherit the default again; an image value is a project-root-relative image path. Pass the version from variables_instance_read to guard against a concurrent edit.",
      inputSchema: SceneVariableUpdateSchema.extend({ projectId }),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`${variables(projectId)}/instance`, "PUT", input),
  );
  server.registerTool(
    "variables_preview",
    {
      description:
        "Replace the overrides the editor's viewer previews for a composition, as hyperframes render --variables would apply them, without writing the source or history. Scalars are checked against each declaration. For an image variable, pass the path of a project image relative to the composition file. Font variables are set in the source. timeline_view still shows the defaults.",
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
    "variables_bind",
    {
      description:
        "Bind an existing variable in one undo step. Use text for a string variable and plain words, color for a color variable and explicit inline text colour, or image for an image variable and an image clip's source. Requires a unique authored element id on an unlocked track. Existing word bindings are refused. composition scopes external template files.",
      inputSchema: VariableBindSchema.extend({ projectId }),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`${variables(projectId)}/bind`, "POST", input),
  );
  server.registerTool(
    "variables_declare",
    {
      description:
        "Declare a string, number, color, boolean, enum or image variable, and optionally bind it to a clip in the same undo step. Bind text for plain words, color for inline text colour, or image for an image clip's source. An image default is a project image path relative to the composition file. Use the clip's current value as the default to preserve its appearance.",
      inputSchema: VariableDeclareSchema.extend({ projectId }),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`${variables(projectId)}/declare`, "POST", input),
  );
}
