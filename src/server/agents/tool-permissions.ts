import type { Options } from "@anthropic-ai/claude-agent-sdk/core";
import { createMcpServer } from "../mcp/server";

// Use the registered annotations, including tools added by the review and timeline modules.
const tools = Array.from(createMcpServer().toolRegistry, ([name, tool]) => ({
  name,
  readOnly: tool.annotations?.readOnlyHint === true,
}));

export const claudeToolPermissions = {
  allowedTools: tools
    .filter((tool) => tool.readOnly)
    .map(({ name }) => `mcp__cutroom_studio__${name}`),
  settings: {
    permissions: {
      ask: tools
        .filter((tool) => !tool.readOnly)
        .map(({ name }) => `mcp__cutroom_studio__${name}`),
    },
  },
} satisfies Pick<Options, "allowedTools" | "settings">;

export const codexToolPermissions: Record<string, string> = {
  "mcp_servers.cutroom_studio.default_tools_approval_mode": "prompt",
  ...Object.fromEntries(
    tools
      .filter((tool) => tool.readOnly)
      .map(({ name }) => [
        `mcp_servers.cutroom_studio.tools.${name}.approval_mode`,
        "approve",
      ]),
  ),
};
