import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { toolTarget } from "../../shared/agent";
import type { AgentMessage } from "../../shared/agent";
import { codexItemSchema, shellCommand } from "./codex";
import { completeMessage, toolCalls } from "./runtime";

const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const claudeBlock = z.union([
  textBlock,
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean().optional(),
  }),
  z.object({ type: z.string() }),
]);
const claudeMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(claudeBlock)]),
});
export const codexTurnsSchema = z.array(
  z.object({
    startedAt: z.number().nullish(),
    items: z.array(codexItemSchema.extend({ name: z.string().nullish() })),
  }),
);

class Transcript {
  private readonly rows = new Map<string, AgentMessage>();
  private omitted = 0;

  constructor(private readonly onOmit?: (id: string) => void) {}

  add(row: AgentMessage, createdAt: string) {
    this.rows.set(row.id, { ...row, createdAt });
    if (this.rows.size <= 200) return;
    const oldest = this.rows.keys().next().value;
    if (oldest === undefined) return;
    this.rows.delete(oldest);
    this.onOmit?.(oldest);
    this.omitted++;
  }

  result() {
    return { messages: [...this.rows.values()], omittedMessages: this.omitted };
  }
}

export function claudeTranscript(
  history: SessionMessage[],
  cwd: string,
  createdAt: string,
) {
  const tools = toolCalls(cwd);
  const transcript = new Transcript(tools.forget);
  for (const entry of history) {
    if (entry.type === "system") continue;
    const parsed = claudeMessage.safeParse(entry.message);
    if (!parsed.success || parsed.data.role !== entry.type) continue;
    const { role, content } = parsed.data;
    const blocks =
      typeof content === "string" ? [{ type: "text", text: content }] : content;
    for (const [index, block] of blocks.entries()) {
      if ("text" in block && block.text)
        transcript.add(
          completeMessage(block.text, role, `import:${entry.uuid}:${index}`),
          createdAt,
        );
      if (role === "assistant" && "name" in block)
        transcript.add(
          {
            ...tools.start(`import:${block.id}`, block.name, block.input ?? {}),
            status: "complete",
          },
          createdAt,
        );
      if (role === "user" && "tool_use_id" in block) {
        const id = `import:${block.tool_use_id}`;
        if (!tools.get(id)) continue;
        transcript.add(
          tools.finish(
            id,
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "", null, 2),
            block.is_error === true,
          ),
          createdAt,
        );
        tools.forget(id);
      }
    }
  }
  return transcript.result();
}

export function codexTranscript(
  turns: z.infer<typeof codexTurnsSchema>,
  cwd: string,
  createdAt: string,
) {
  const transcript = new Transcript();
  const tools = toolCalls(cwd);
  for (const turn of turns) {
    const time = turn.startedAt
      ? new Date(turn.startedAt * 1000).toISOString()
      : createdAt;
    for (const item of turn.items) {
      const id = `import:${item.id}`;
      if (item.type === "userMessage") {
        const content = z.array(z.unknown()).safeParse(item.content);
        if (!content.success) continue;
        const text = content.data
          .flatMap((block) => {
            const parsed = textBlock.safeParse(block);
            return parsed.success ? [parsed.data.text] : [];
          })
          .join("\n");
        if (text) transcript.add(completeMessage(text, "user", id), time);
      }
      if (item.type === "agentMessage" && item.text)
        transcript.add(completeMessage(item.text, "assistant", id), time);
      const failed =
        ["failed", "declined"].includes(item.status ?? "") ||
        Boolean(item.error);
      if (item.type === "commandExecution" && item.command) {
        const output = (item.aggregatedOutput ?? "").slice(-32_000);
        transcript.add(
          {
            ...completeMessage(
              [item.command, output].filter(Boolean).join("\n"),
              "tool",
              id,
              "Shell",
              toolTarget({ command: shellCommand(item.command) }, cwd),
            ),
            status: failed ? "failed" : "complete",
          },
          time,
        );
      }
      if (item.type === "fileChange") {
        const paths = item.changes ?? [];
        transcript.add(
          {
            ...completeMessage(
              paths.map(({ path }) => path).join("\n"),
              "tool",
              id,
              "Files",
              paths.map((change) => toolTarget(change, cwd)).join(", "),
            ),
            status: failed ? "failed" : "complete",
          },
          time,
        );
      }
      if (
        item.type === "mcpToolCall" ||
        item.type === "dynamicToolCall" ||
        item.type === "collabAgentToolCall" ||
        item.type === "webSearch" ||
        item.type === "functionCallOutput"
      ) {
        const tool =
          item.type === "mcpToolCall"
            ? `${item.server ?? "MCP"}: ${item.tool ?? "tool"}`
            : (item.tool ??
              (item.type === "webSearch" ? "Web search" : "Tool"));
        const input =
          item.arguments ??
          (item.type === "webSearch" ? { query: item.query } : {});
        const result = item.result ?? item.contentItems ?? item.output;
        tools.start(id, tool, input);
        transcript.add(
          tools.finish(
            id,
            item.error?.message ?? JSON.stringify(result ?? input, null, 2),
            failed,
          ),
          time,
        );
        tools.forget(id);
      }
    }
  }
  return transcript.result();
}
