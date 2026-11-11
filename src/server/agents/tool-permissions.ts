import {
  getObjectShape,
  isSchemaOptional,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type {
  Options,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk/core";
import { z } from "zod";
import { createMcpServer } from "../mcp/server";

// The registry is the permission boundary. Unknown tools always ask.
export const cutroomToolRegistry = createMcpServer().toolRegistry;
const tools = Array.from(cutroomToolRegistry, ([name, tool]) => {
  const projectId = getObjectShape(tool.inputSchema)?.projectId;
  return {
    name,
    readOnly: tool.annotations?.readOnlyHint === true,
    // Export writes a chosen output folder, beyond the project's editable files.
    projectScoped:
      name !== "export_start" &&
      projectId !== undefined &&
      !isSchemaOptional(projectId),
  };
});
const editTools = new Set(
  tools
    .filter((tool) => !tool.readOnly && tool.projectScoped)
    .map((tool) => tool.name),
);

export function isCutroomEdit(tool: string) {
  const prefix = "mcp__cutroom_studio__";
  return tool.startsWith(prefix) && editTools.has(tool.slice(prefix.length));
}

export function claudeToolPermissions(always = false) {
  // Native ask/deny rules take precedence over these allow entries. Do not add our own
  // ask rules for project edits: they would override an owner choosing Always allow.
  // Creation/import have no existing project and always require approval.
  return {
    allowedTools: tools
      .filter((tool) => tool.readOnly || (always && tool.projectScoped))
      .map(({ name }) => `mcp__cutroom_studio__${name}`),
    settings: {
      permissions: {
        ask: tools
          .filter((tool) => !tool.readOnly && !tool.projectScoped)
          .map(({ name }) => `mcp__cutroom_studio__${name}`),
      },
    },
  } satisfies Pick<Options, "allowedTools" | "settings">;
}

export const claudeEditPermission: PermissionUpdate = {
  type: "addRules",
  behavior: "allow",
  destination: "session",
  rules: [...editTools].map((name) => ({
    toolName: `mcp__cutroom_studio__${name}`,
  })),
};

const approvalMode = z.enum(["auto", "prompt", "approve"]);
const codexNativeConfigSchema = z.object({
  mcp_servers: z
    .object({
      cutroom_studio: z
        .object({
          default_tools_approval_mode: approvalMode.nullish(),
          tools: z
            .record(
              z.string(),
              z.object({ approval_mode: approvalMode.nullish() }),
            )
            .default({}),
        })
        .optional(),
    })
    .optional(),
});
export const codexPermissionConfigSchema = z.object({
  config: codexNativeConfigSchema,
  layers: z.array(z.object({ config: codexNativeConfigSchema })).nullish(),
});
export type CodexToolConfig = NonNullable<
  NonNullable<
    z.infer<typeof codexNativeConfigSchema>["mcp_servers"]
  >["cutroom_studio"]
>;

export function codexAsks(configs: readonly CodexToolConfig[], name: string) {
  return configs.some(
    (config) =>
      (config.tools[name]?.approval_mode ??
        config.default_tools_approval_mode) === "prompt",
  );
}

export function codexToolPermissions(
  always = false,
  configs: readonly CodexToolConfig[] = [],
): Record<string, string> {
  return {
    "mcp_servers.cutroom_studio.default_tools_approval_mode": "prompt",
    ...Object.fromEntries(
      tools.map(({ name, readOnly, projectScoped }) => [
        `mcp_servers.cutroom_studio.tools.${name}.approval_mode`,
        codexAsks(configs, name)
          ? "prompt"
          : readOnly || (always && projectScoped)
            ? "approve"
            : "prompt",
      ]),
    ),
  };
}
