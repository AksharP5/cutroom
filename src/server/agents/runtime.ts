import type {
  AgentCapabilities,
  AgentEvent,
  AgentProvider,
  AgentMessage,
  AgentRequest,
  AgentResponse,
  AgentSession,
  AgentTurn,
} from "../../shared/agent";
import { toolTarget } from "../../shared/agent";
import { CUTROOM_SERVER, editSummary, parseTool } from "../../shared/toolRow";
import { reviewReplyGuidance } from "../../shared/review";
import type { ToolNames } from "./tool-subject";

export type ModelSelection = Pick<AgentSession, "model" | "effort">;

export interface RuntimeOptions extends ModelSelection {
  cwd: string;
  /** Identifies this conversation's review actions; its MCP bridge sends it with every call. */
  agentToken: string;
  allowCutroomEdits?: () => boolean;
  /** What the editor calls the notes, clips, and transcripts a tool call names by id. */
  names?: ToolNames;
  nativeSessionId?: string;
  emit: (event: AgentEvent) => void;
  request: (
    request: AgentRequest,
    signal?: AbortSignal,
  ) => Promise<AgentResponse>;
}

export interface AgentRuntime {
  prepare?(): Promise<void>;
  /** Close a resumed query after its final writes. Returns whether it reported a turn result. */
  closeAfterTurn?(): Promise<boolean>;
  send(turn: AgentTurn): Promise<void>;
  configureModel?(selection: ModelSelection): void;
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

export function agentInstructions(cwd: string): string {
  return [
    `This Cutroom project is an ordinary HyperFrames folder at ${cwd}.`,
    "Use the cutroom_studio MCP tools to inspect and edit the open video when available. Keep source media intact. Edits to project files refresh the editor.",
    "For composition HTML, animation, captions, audio, or rendering, load relevant installed HyperFrames skills yourself, such as hyperframes, hyperframes-core, hyperframes-animation, and hyperframes-media. If none are installed, carry on with the MCP tools.",
    reviewReplyGuidance,
  ].join("\n");
}

export function agentPrompt(turn: AgentTurn): string {
  const parts = [turn.text];
  if (turn.context)
    parts.push(`<cutroom-context>\n${turn.context}\n</cutroom-context>`);
  if (turn.attachments.length)
    parts.push(
      `Attached local files:\n${turn.attachments.map((file) => file.path).join("\n")}`,
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
  const calls = new Map<string, AgentMessage>();
  return {
    get: (id: string) => calls.get(id),
    /** `subject` names what one of Cutroom's own tools acts on; native tools name a file or command. */
    start(
      id: string,
      name: string,
      input: unknown,
      subject?: string,
    ): AgentMessage {
      const target =
        parseTool(name).server === CUTROOM_SERVER
          ? subject
          : toolTarget(input, cwd);
      const message: AgentMessage = {
        ...completeMessage(
          JSON.stringify(input, null, 2).slice(-32_000),
          "tool",
          id,
          name,
          target,
        ),
        status: "streaming",
      };
      calls.set(id, message);
      return message;
    },
    finish(id: string, text: string, failed: boolean): AgentMessage {
      const call = calls.get(id);
      // Read from the whole result: the row keeps only its tail.
      const summary = failed ? undefined : editSummary(call?.tool, text);
      const message: AgentMessage = {
        ...(call ?? completeMessage("", "tool", id, "Tool")),
        text: text.slice(-32_000),
        status: failed ? "failed" : "complete",
        ...(summary && { summary }),
      };
      calls.set(id, message);
      return message;
    },
    /** Upgrade the latest row, including its result, without replaying stale input or status. */
    rename(id: string, target: string) {
      const call = calls.get(id);
      if (!call) return undefined;
      const message = { ...call, target };
      calls.set(id, message);
      return message;
    },
    forget: (id: string) => calls.delete(id),
    clear: () => calls.clear(),
  };
}
