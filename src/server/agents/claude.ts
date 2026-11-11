import type {
  CanUseTool,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk/core";
import { z } from "zod";
import type {
  AgentCapabilities,
  AgentRequest,
  AgentTurn,
} from "../../shared/agent";
import { toolApproval } from "./tool-approval";
import { toolSubject } from "./tool-subject";
import {
  claudeToolPermissions,
  claudeEditPermission,
  isCutroomEdit,
} from "./tool-permissions";
import { InputQueue } from "./input-queue";
import { agentPrompt, completeMessage, toolCalls } from "./runtime";
import type { AgentRuntime, RuntimeOptions } from "./runtime";

const authStatusSchema = z.object({
  loggedIn: z.boolean(),
  apiProvider: z.string().optional(),
});
const questionInputSchema = z
  .object({
    questions: z.array(
      z
        .object({
          question: z.string(),
          options: z
            .array(z.object({ label: z.string() }).passthrough())
            .optional(),
          multiSelect: z.boolean().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const imageTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
type StudioMcp = NonNullable<Options["mcpServers"]>;

function nativeOptions(
  cwd: string,
  studioMcp: StudioMcp,
  always = false,
): Options {
  const executable = Bun.which("claude");
  if (!executable)
    throw new Error(
      "Claude Code is not installed. Install and sign in to Claude Code, then refresh.",
    );
  return {
    cwd,
    pathToClaudeCodeExecutable: executable,
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,
    permissionMode: "default",
    ...claudeToolPermissions(always),
    mcpServers: studioMcp,
  };
}

export async function claudeCapabilities(
  cwd: string,
  studioMcp: StudioMcp,
  signal?: AbortSignal,
): Promise<AgentCapabilities> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk/core");
  const input = new InputQueue<SDKUserMessage>();
  const session = query({
    prompt: input,
    options: nativeOptions(cwd, studioMcp),
  });
  const close = () => session.close();
  signal?.addEventListener("abort", close, { once: true });
  const timeout = setTimeout(close, 30_000);
  try {
    const executable = Bun.which("claude");
    if (!executable) throw new Error("Claude Code is not installed.");
    const auth = Bun.spawn([executable, "auth", "status", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const authStatus = new Response(auth.stdout)
      .text()
      .then((raw) => authStatusSchema.parse(JSON.parse(raw)));
    const [initial, authentication] = await Promise.all([
      session.initializationResult(),
      authStatus,
    ]);
    const [commands, servers] = await Promise.all([
      session.supportedCommands(),
      session.mcpServerStatus(),
    ]);
    await auth.exited;
    const available =
      authentication.loggedIn ||
      (authentication.apiProvider !== undefined &&
        authentication.apiProvider !== "firstParty");
    return {
      provider: "claude",
      available,
      ...(!available
        ? {
            error:
              "Claude Code is installed but not signed in. Run claude auth login in a terminal, then refresh.",
          }
        : {}),
      skills: commands
        .filter((command) => !command.builtin)
        .map((command) => ({
          name: command.name,
          description: command.description,
          enabled: true,
        })),
      models: initial.models.map((model) => ({
        id: model.value,
        name: model.displayName,
        description: model.description,
        isDefault: model.value === "default",
      })),
      mcpServers: servers.map((server) => ({
        name: server.name,
        status: server.status,
      })),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", close);
    input.close();
    session.close();
  }
}

export class ClaudeRuntime implements AgentRuntime {
  private readonly input = new InputQueue<SDKUserMessage>();
  private query?: Query;
  private starting?: Promise<Query>;
  private active?: { resolve: () => void; reject: (error: Error) => void };
  private currentMessageId?: string;
  private readonly text = new Map<string, string>();
  private readonly tools: ReturnType<typeof toolCalls>;
  private nativeSessionId?: string;
  private hasAssistantText = false;
  private disposed = false;
  private stopRequested = false;
  private naming?: AbortController;

  constructor(
    private readonly options: RuntimeOptions,
    private readonly studioMcp: StudioMcp,
  ) {
    this.nativeSessionId = options.nativeSessionId;
    this.tools = toolCalls(options.cwd);
  }

  private ensureQuery() {
    this.starting ??= (async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk/core");
      const session = query({
        prompt: this.input,
        options: {
          ...nativeOptions(
            this.options.cwd,
            this.studioMcp,
            this.options.allowCutroomEdits?.(),
          ),
          ...(this.options.model ? { model: this.options.model } : {}),
          ...(this.nativeSessionId ? { resume: this.nativeSessionId } : {}),
          canUseTool: this.canUseTool,
        },
      });
      this.query = session;
      void this.read(session).catch((error) => {
        if (this.disposed) return;
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.active?.reject(failure);
        if (!this.active)
          this.options.emit({ type: "error", message: failure.message });
      });
      await session.initializationResult();
      return session;
    })();
    return this.starting;
  }

  private canUseTool: CanUseTool = async (tool, input, context) => {
    // "Write index.html?" rather than the tool's internal name.
    const approval = await toolApproval(
      tool,
      input,
      this.options.cwd,
      this.options.names,
      context.signal,
    );
    if (context.signal.aborted)
      return { behavior: "deny", message: "The turn has ended." };
    const target = approval.target;
    const questions =
      tool === "AskUserQuestion"
        ? questionInputSchema.safeParse(input)
        : undefined;
    const request: AgentRequest = {
      id: context.requestId,
      kind: questions?.success ? "question" : "approval",
      tool,
      canAllowCutroomEdits:
        isCutroomEdit(tool) && !this.options.allowCutroomEdits?.(),
      title:
        tool === "AskUserQuestion" ? "Claude has a question" : approval.title,
      input: approval.input,
      ...(approval.detail ? { detail: approval.detail } : {}),
      ...(target ? { target } : {}),
      ...(questions?.success
        ? {
            questions: questions.data.questions.map((question) => ({
              id: question.question,
              question: question.question,
              options: question.options?.map((option) => option.label) ?? [],
              multiple: question.multiSelect ?? false,
            })),
          }
        : {}),
    };
    const response = await this.options.request(request, context.signal);
    if (response.decision === "deny")
      return { behavior: "deny", message: "The user declined this request." };
    const answers = Object.fromEntries(
      Object.entries(response.answers ?? {}).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(", ") : value,
      ]),
    );
    return {
      behavior: "allow",
      updatedInput: questions?.success ? { ...input, answers } : approval.input,
      ...(response.alwaysAllowCutroomEdits &&
        isCutroomEdit(tool) && { updatedPermissions: [claudeEditPermission] }),
    };
  };

  async send(turn: AgentTurn) {
    this.stopRequested = false;
    await this.ensureQuery();
    if (this.stopRequested) return;
    if (this.active)
      throw new Error("Claude is already working in this conversation.");
    this.hasAssistantText = false;
    const prompt = agentPrompt(turn, this.options.cwd);
    const firstSkill = turn.skills[0];
    const skills = firstSkill ? `/${firstSkill.name}` : "";
    const additionalSkills = turn.skills.slice(1);
    const skillContext = additionalSkills.length
      ? `\n\nAlso invoke the Skill tool for each of these selected native skills before doing the work: ${additionalSkills.map((skill) => skill.name).join(", ")}.`
      : "";
    const text = skills
      ? `${skills}\n${prompt.replace(/\$[\w:/.-]+/g, (token) => (turn.skills.some((skill) => token === `$${skill.name}`) ? "" : token))}${skillContext}`
      : prompt;
    const content: Exclude<
      Extract<SDKUserMessage["message"], { role: "user" }>["content"],
      string
    > = [{ type: "text", text }];
    for (const attachment of turn.attachments) {
      const file = Bun.file(attachment.path);
      const imageType = imageTypeSchema.safeParse(
        attachment.mimeType ?? file.type,
      );
      if (!imageType.success) continue;
      if (file.size > 20 * 1024 * 1024)
        throw new Error("Image attachments must be smaller than 20 MB.");
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: imageType.data,
          data: Buffer.from(await file.arrayBuffer()).toString("base64"),
        },
      });
    }
    if (this.stopRequested) return;
    const completed = new Promise<void>((resolve, reject) => {
      this.active = { resolve, reject };
    });
    this.naming = new AbortController();
    try {
      this.input.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        uuid: crypto.randomUUID(),
        ...(this.nativeSessionId ? { session_id: this.nativeSessionId } : {}),
      });
      await completed;
    } finally {
      this.naming.abort();
      this.active = undefined;
      this.currentMessageId = undefined;
      this.text.clear();
      this.tools.clear();
    }
  }

  private async read(session: Query) {
    for await (const message of session) this.receive(message);
    if (!this.disposed) {
      const error = new Error(
        "The Claude Code connection closed. Send a message to reconnect.",
      );
      if (this.active) this.active.reject(error);
      else this.options.emit({ type: "error", message: error.message });
    }
  }

  private receive(message: SDKMessage) {
    if (
      "session_id" in message &&
      message.session_id &&
      message.session_id !== this.nativeSessionId
    ) {
      this.nativeSessionId = message.session_id;
      this.options.emit({
        type: "native-session",
        nativeSessionId: message.session_id,
      });
    }
    if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "message_start") {
        this.currentMessageId = event.message.id;
        this.text.set(event.message.id, "");
        this.options.emit({
          type: "message",
          message: {
            ...completeMessage("", "assistant", event.message.id),
            status: "streaming",
          },
        });
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta" &&
        this.currentMessageId
      ) {
        this.hasAssistantText = true;
        this.text.set(
          this.currentMessageId,
          (this.text.get(this.currentMessageId) ?? "") + event.delta.text,
        );
        this.options.emit({
          type: "delta",
          messageId: this.currentMessageId,
          text: event.delta.text,
        });
      }
      return;
    }
    if (message.type === "assistant") {
      const text = message.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const accumulated = this.text.get(message.message.id);
      this.text.delete(message.message.id);
      if (text || accumulated) {
        this.hasAssistantText = true;
        this.options.emit({
          type: "message",
          message: completeMessage(
            accumulated || text,
            "assistant",
            message.message.id,
          ),
        });
      }
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        this.options.emit({
          type: "message",
          message: this.tools.start(block.id, block.name, block.input),
        });
        const signal = this.naming?.signal;
        void toolSubject(block.name, block.input, this.options.names).then(
          (target) => {
            if (!target || !signal || signal.aborted) return;
            const message = this.tools.rename(block.id, target);
            if (message) this.options.emit({ type: "message", message });
          },
        );
      }
      return;
    }
    if (
      message.type === "user" &&
      typeof message.message.content !== "string"
    ) {
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        const text =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "", null, 2);
        this.options.emit({
          type: "message",
          message: this.tools.finish(
            block.tool_use_id,
            text,
            block.is_error === true,
          ),
        });
      }
      return;
    }
    if (message.type === "result") {
      this.naming?.abort();
      if (message.is_error || message.subtype !== "success") {
        this.active?.reject(
          new Error(
            message.subtype === "success"
              ? message.result
              : message.errors.join("\n"),
          ),
        );
        return;
      }
      if (!this.hasAssistantText && message.result)
        this.options.emit({
          type: "message",
          message: completeMessage(message.result),
        });
      this.active?.resolve();
    }
  }

  async interrupt() {
    this.stopRequested = true;
    this.naming?.abort();
    if (this.query) await this.query.interrupt();
  }
  dispose() {
    this.naming?.abort();
    this.disposed = true;
    this.input.close();
    this.query?.close();
    this.active?.reject(new Error("The conversation was closed."));
  }
}
