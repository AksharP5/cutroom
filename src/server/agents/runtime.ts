import type {
  AgentCapabilities,
  AgentEvent,
  AgentProvider,
  AgentMessage,
  AgentRequest,
  AgentResponse,
  AgentTurn,
} from "../../shared/agent";
import { toolTarget } from "../../shared/agent";

export interface RuntimeOptions {
  cwd: string;
  /** Identifies this conversation's review actions; its MCP bridge sends it with every call. */
  agentToken: string;
  allowCutroomEdits?: () => boolean;
  model?: string;
  nativeSessionId?: string;
  emit: (event: AgentEvent) => void;
  request: (
    request: AgentRequest,
    signal?: AbortSignal,
  ) => Promise<AgentResponse>;
}

export interface AgentRuntime {
  send(turn: AgentTurn): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): void;
}

export interface RuntimeFactory {
  capabilities(
    provider: AgentProvider,
    cwd: string,
  ): Promise<AgentCapabilities>;
  create(provider: AgentProvider, options: RuntimeOptions): AgentRuntime;
  dispose(): void;
}

export function agentPrompt(turn: AgentTurn, cwd: string): string {
  const parts = [turn.text];
  if (turn.context) parts.push(`Video review context:\n${turn.context}`);
  if (turn.attachments.length)
    parts.push(
      `Attached local files:\n${turn.attachments.map((file) => file.path).join("\n")}`,
    );
  parts.push(
    `Working project: ${cwd}\nUse the cutroom MCP tools to inspect and edit the active video when available. Keep source media intact. Changes to the project files refresh the editor.`,
  );
  return parts.filter(Boolean).join("\n\n");
}

export function completeMessage(
  text: string,
  role: AgentMessage["role"] = "assistant",
  id: string = crypto.randomUUID(),
  tool?: string,
  target?: string,
) {
  return {
    id,
    role,
    text,
    status: "complete" as const,
    createdAt: new Date().toISOString(),
    ...(tool ? { tool } : {}),
    ...(target ? { target } : {}),
  };
}

/**
 * A native tool call's two messages: its input while it runs, then its result. The result
 * keeps the name and project-relative target so the row still says what the call touched.
 */
export function toolCalls(cwd: string) {
  const calls = new Map<string, { name: string; target?: string }>();
  return {
    start(id: string, name: string, input: unknown): AgentMessage {
      const target = toolTarget(input, cwd);
      calls.set(id, { name, target });
      return {
        ...completeMessage(
          JSON.stringify(input, null, 2).slice(-32_000),
          "tool",
          id,
          name,
          target,
        ),
        status: "streaming",
      };
    },
    finish(id: string, text: string, failed: boolean): AgentMessage {
      const call = calls.get(id);
      calls.delete(id);
      return {
        ...completeMessage(
          text.slice(-32_000),
          "tool",
          id,
          call?.name ?? "Tool",
          call?.target,
        ),
        status: failed ? "failed" : "complete",
      };
    },
    clear: () => calls.clear(),
  };
}
