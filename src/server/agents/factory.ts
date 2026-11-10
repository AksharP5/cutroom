import type { Options } from "@anthropic-ai/claude-agent-sdk/core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentCapabilities, AgentProvider } from "../../shared/agent";
import { ClaudeRuntime, claudeCapabilities } from "./claude";
import { CodexClient } from "./codex-client";
import { CodexRuntime, codexCapabilities } from "./codex";
import type { RuntimeFactory, RuntimeOptions } from "./runtime";

export function createNativeRuntimeFactory(
  studioUrl = process.env.CUTROOM_PORT
    ? `http://127.0.0.1:${process.env.CUTROOM_PORT}`
    : (process.env.CUTROOM_URL ?? "http://127.0.0.1:4317"),
): RuntimeFactory {
  let codex: CodexClient | undefined;
  const discoveries = new Set<AbortController>();
  const bridge = resolve(import.meta.dir, "../mcp/stdio.ts");
  const command = Bun.which("bun") ?? process.execPath;
  // A conversation's token lets the server credit its review actions to its own run.
  const studioMcp = (
    agentToken?: string,
  ): NonNullable<Options["mcpServers"]> =>
    existsSync(bridge)
      ? {
          cutroom_studio: {
            type: "stdio" as const,
            command,
            args: [bridge],
            env: {
              CUTROOM_URL: studioUrl,
              ...(agentToken && { CUTROOM_AGENT_TOKEN: agentToken }),
            },
          },
        }
      : {};
  const codexClient = () => {
    if (!codex?.connected)
      codex = new CodexClient({
        args: [
          "app-server",
          "--listen",
          "stdio://",
          ...(existsSync(bridge)
            ? [
                "-c",
                `mcp_servers.cutroom_studio.command=${JSON.stringify(command)}`,
                "-c",
                `mcp_servers.cutroom_studio.args=${JSON.stringify([bridge])}`,
                "-c",
                `mcp_servers.cutroom_studio.env.CUTROOM_URL=${JSON.stringify(studioUrl)}`,
              ]
            : []),
        ],
      });
    return codex;
  };
  return {
    async capabilities(
      provider: AgentProvider,
      cwd: string,
    ): Promise<AgentCapabilities> {
      const controller = new AbortController();
      discoveries.add(controller);
      try {
        return provider === "codex"
          ? await codexCapabilities(codexClient(), cwd)
          : await claudeCapabilities(cwd, studioMcp(), controller.signal);
      } catch (error) {
        return {
          provider,
          available: false,
          skills: [],
          models: [],
          mcpServers: [],
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        discoveries.delete(controller);
      }
    },
    create(provider: AgentProvider, options: RuntimeOptions) {
      // Codex starts MCP servers per thread and applies the thread's config overrides to them.
      return provider === "codex"
        ? new CodexRuntime(
            codexClient(),
            options,
            existsSync(bridge)
              ? {
                  "mcp_servers.cutroom_studio.env.CUTROOM_AGENT_TOKEN":
                    options.agentToken,
                }
              : {},
          )
        : new ClaudeRuntime(options, studioMcp(options.agentToken));
    },
    dispose() {
      for (const controller of discoveries) controller.abort();
      discoveries.clear();
      codex?.dispose();
      codex = undefined;
    },
  };
}
