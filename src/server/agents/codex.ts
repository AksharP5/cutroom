import { z } from "zod";
import type {
  AgentCapabilities,
  AgentQuestion,
  AgentRequest,
  AgentTurn,
} from "../../shared/agent";
import { toolTarget } from "../../shared/agent";
import { approvalTitle } from "../../shared/toolRow";
import {
  codexAsks,
  codexPermissionConfigSchema,
  codexToolPermissions,
  isCutroomEdit,
} from "./tool-permissions";
import type { CodexToolConfig } from "./tool-permissions";
import { CodexClient } from "./codex-client";
import type { RpcMessage } from "./codex-client";
import { agentPrompt, completeMessage } from "./runtime";
import type { AgentRuntime, RuntimeOptions } from "./runtime";

const threadResultSchema = z.object({ thread: z.object({ id: z.string() }) });
const turnResultSchema = z.object({ turn: z.object({ id: z.string() }) });
const skillsResultSchema = z.object({
  data: z.array(
    z.object({
      cwd: z.string(),
      skills: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          path: z.string(),
          scope: z.string(),
          enabled: z.boolean(),
        }),
      ),
      errors: z.array(z.unknown()).optional(),
    }),
  ),
});
const modelsResultSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      displayName: z.string(),
      description: z.string(),
      hidden: z.boolean().optional(),
      isDefault: z.boolean().optional(),
    }),
  ),
});
const mcpResultSchema = z.object({
  data: z.array(
    z.object({ name: z.string(), status: z.string().optional() }).passthrough(),
  ),
});
const itemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    text: z.string().optional(),
    command: z.string().optional(),
    aggregatedOutput: z.string().nullish(),
    tool: z.string().optional(),
    server: z.string().optional(),
    arguments: z.unknown().optional(),
    result: z.unknown().optional(),
    changes: z.array(z.object({ path: z.string() }).passthrough()).optional(),
    status: z.string().optional(),
  })
  .passthrough();
const deltaSchema = z.object({
  threadId: z.string(),
  itemId: z.string(),
  delta: z.string(),
});
const turnCompletedSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.string(),
    error: z.object({ message: z.string() }).nullable().optional(),
  }),
});
const mcpApprovalSchema = z.object({
  serverName: z.string(),
  _meta: z.object({
    codex_approval_kind: z.literal("mcp_tool_call"),
    tool_name: z.string(),
    tool_params: z.record(z.string(), z.unknown()),
  }),
});

const nativeQuestionsSchema = z.array(
  z
    .object({
      id: z.string().optional(),
      question: z.string(),
      options: z.array(z.object({ label: z.string() }).passthrough()).nullish(),
      multiSelect: z.boolean().optional(),
    })
    .passthrough(),
);

export async function codexCapabilities(
  client: CodexClient,
  cwd: string,
): Promise<AgentCapabilities> {
  const [skills, models, servers] = await Promise.all([
    client
      .call("skills/list", { cwds: [cwd], forceReload: true })
      .then((value) => skillsResultSchema.parse(value)),
    client.call("model/list").then((value) => modelsResultSchema.parse(value)),
    client
      .call("mcpServerStatus/list")
      .then((value) => mcpResultSchema.parse(value)),
  ]);
  return {
    provider: "codex",
    available: true,
    version: client.version,
    skills: skills.data.flatMap((row) => row.skills),
    models: models.data
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.model,
        name: model.displayName,
        description: model.description,
        isDefault: model.isDefault,
      })),
    mcpServers: servers.data.map((server) => ({
      name: server.name,
      status: server.status ?? "configured",
    })),
  };
}

export class CodexRuntime implements AgentRuntime {
  private threadId?: string;
  private permissionConfigs: CodexToolConfig[] = [];
  private turnId?: string;
  private stopRequested = false;
  private turnFinished = false;
  private starting?: Promise<string>;
  private active?: { resolve: () => void; reject: (error: Error) => void };
  private readonly seen = new Set<string>();
  private readonly commands = new Map<
    string,
    { command: string; output: string }
  >();
  private readonly unlisten;

  constructor(
    private readonly client: CodexClient,
    private readonly options: RuntimeOptions,
    private readonly threadConfig: Record<string, string> = {},
  ) {
    this.unlisten = client.subscribe((message) => {
      try {
        this.receive(message);
      } catch (error) {
        this.active?.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  private ensureThread() {
    if (this.threadId) return Promise.resolve(this.threadId);
    this.starting ??= (async () => {
      const native = codexPermissionConfigSchema.parse(
        await this.client.call("config/read", {
          cwd: this.options.cwd,
          includeLayers: true,
        }),
      );
      // Even an untrusted project's ask rules may restrict Cutroom's grant. Read
      // restrictions only; never enable tools or permissions from a disabled layer.
      this.permissionConfigs = [
        native.config,
        ...(native.layers ?? []).map((layer) => layer.config),
      ].flatMap((config) =>
        config.mcp_servers?.cutroom_studio
          ? [config.mcp_servers.cutroom_studio]
          : [],
      );
      return this.client.call(
        this.options.nativeSessionId ? "thread/resume" : "thread/start",
        {
          ...(this.options.nativeSessionId
            ? { threadId: this.options.nativeSessionId, excludeTurns: true }
            : {}),
          cwd: this.options.cwd,
          ...(this.options.model ? { model: this.options.model } : {}),
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          serviceName: "cutroom",
          config: {
            ...this.threadConfig,
            ...codexToolPermissions(
              this.options.allowCutroomEdits?.(),
              this.permissionConfigs,
            ),
          },
        },
      );
    })().then((value) => {
      const id = threadResultSchema.parse(value).thread.id;
      this.threadId = id;
      this.options.emit({ type: "native-session", nativeSessionId: id });
      return id;
    });
    return this.starting;
  }

  async send(turn: AgentTurn) {
    this.stopRequested = false;
    this.turnFinished = false;
    const threadId = await this.ensureThread();
    if (this.stopRequested) return;
    if (this.active)
      throw new Error("Codex is already working in this conversation.");
    const input: Array<Record<string, unknown>> = [
      { type: "text", text: agentPrompt(turn, this.options.cwd) },
    ];
    for (const skill of turn.skills) {
      if (!skill.path)
        throw new Error(
          `The skill ${skill.name} has no native path. Refresh the skill list and select it again.`,
        );
      input.push({ type: "skill", name: skill.name, path: skill.path });
    }
    for (const attachment of turn.attachments) {
      if (/\.(png|jpe?g|webp|gif)$/i.test(attachment.path))
        input.push({ type: "localImage", path: attachment.path });
    }
    const completed = new Promise<void>((resolve, reject) => {
      this.active = { resolve, reject };
    });
    try {
      await Promise.all([
        completed,
        this.client
          .call("turn/start", { threadId, input })
          .then(async (value) => {
            this.turnId = turnResultSchema.parse(value).turn.id;
            if (this.stopRequested && !this.turnFinished)
              await this.interrupt();
          }),
      ]);
    } catch (error) {
      if (!this.turnFinished && this.turnId) {
        try {
          await this.interrupt();
        } catch (stopError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} The native run could not be stopped: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
          );
        }
      }
      throw error;
    } finally {
      this.active = undefined;
      this.turnId = undefined;
      this.commands.clear();
      this.seen.clear();
    }
  }

  private receive(message: RpcMessage) {
    const params = message.params ?? {};
    if (message.method === "cutroom/disconnected") {
      const error = new Error(
        typeof params.message === "string"
          ? params.message
          : "The Codex connection closed.",
      );
      if (this.active) this.active.reject(error);
      else this.options.emit({ type: "error", message: error.message });
      return;
    }
    if (!this.threadId || params.threadId !== this.threadId) return;
    if (message.id !== undefined && message.method) {
      void this.answerRequest(message.id, message.method, params).catch(
        (error) => {
          this.client.reject(
            message.id ?? "unknown",
            error instanceof Error ? error.message : String(error),
          );
        },
      );
      return;
    }
    if (message.method === "turn/started") {
      this.turnId = turnResultSchema.parse(params).turn.id;
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = deltaSchema.parse(params);
      this.startMessage(delta.itemId);
      this.options.emit({
        type: "delta",
        messageId: delta.itemId,
        text: delta.delta,
      });
      return;
    }
    if (message.method === "item/commandExecution/outputDelta") {
      const delta = deltaSchema.parse(params);
      const command = this.commands.get(delta.itemId);
      if (!command) return;
      const output = command.output + delta.delta;
      command.output = output.slice(-32_000);
      if (output.length > 32_000) {
        this.options.emit({
          type: "message",
          message: {
            ...completeMessage(
              `${command.command}\n${command.output}`,
              "tool",
              delta.itemId,
              "Shell",
              toolTarget({ command: command.command }, this.options.cwd),
            ),
            status: "streaming",
          },
        });
      } else {
        this.options.emit({
          type: "delta",
          messageId: delta.itemId,
          text: delta.delta,
        });
      }
      return;
    }
    if (
      message.method === "item/started" ||
      message.method === "item/completed"
    ) {
      const item = itemSchema.parse(params.item);
      if (item.type === "agentMessage") {
        if (message.method === "item/started") this.startMessage(item.id);
        else
          this.options.emit({
            type: "message",
            message: completeMessage(item.text ?? "", "assistant", item.id),
          });
      }
      if (item.type === "commandExecution") {
        const previous = this.commands.get(item.id);
        const command = item.command ?? previous?.command ?? "Command";
        const output = (item.aggregatedOutput ?? previous?.output ?? "").slice(
          -32_000,
        );
        const completed = message.method === "item/completed";
        if (completed) this.commands.delete(item.id);
        else this.commands.set(item.id, { command, output });
        this.options.emit({
          type: "message",
          message: {
            ...completeMessage(
              `${command}${!completed || output ? "\n" : ""}${output}`,
              "tool",
              item.id,
              "Shell",
              toolTarget({ command }, this.options.cwd),
            ),
            status: !completed
              ? "streaming"
              : item.status === "failed" || item.status === "declined"
                ? "failed"
                : "complete",
          },
        });
      }
      if (item.type === "fileChange")
        this.options.emit({
          type: "message",
          message: completeMessage(
            item.changes?.map((change) => change.path).join("\n") ??
              "Editing project files",
            "tool",
            item.id,
            "Files",
            item.changes
              ?.map((change) => toolTarget(change, this.options.cwd))
              .join(", "),
          ),
        });
      if (item.type === "mcpToolCall")
        this.options.emit({
          type: "message",
          message: {
            ...completeMessage(
              JSON.stringify(
                message.method === "item/completed"
                  ? (item.result ?? {})
                  : (item.arguments ?? {}),
                null,
                2,
              ).slice(-32_000),
              "tool",
              item.id,
              `${item.server ?? "MCP"}: ${item.tool ?? "tool"}`,
              toolTarget(item.arguments, this.options.cwd),
            ),
            status:
              message.method === "item/completed" ? "complete" : "streaming",
          },
        });
      return;
    }
    if (message.method === "turn/completed") {
      const result = turnCompletedSchema.parse(params).turn;
      this.turnFinished = true;
      if (result.status === "failed")
        this.active?.reject(
          new Error(
            result.error?.message ?? "Codex could not complete the request.",
          ),
        );
      else this.active?.resolve();
    }
    if (message.method === "error" && params.willRetry !== true) {
      const error = z.object({ message: z.string() }).safeParse(params.error);
      this.active?.reject(
        new Error(
          error.success
            ? error.data.message
            : "Codex reported a runtime error.",
        ),
      );
    }
  }

  private startMessage(id: string) {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.options.emit({
      type: "message",
      message: { ...completeMessage("", "assistant", id), status: "streaming" },
    });
  }

  private async answerRequest(
    id: string | number,
    method: string,
    params: Record<string, unknown>,
  ) {
    const supported = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/tool/requestUserInput",
      "item/permissions/requestApproval",
      "mcpServer/elicitation/request",
    ];
    if (!supported.includes(method)) {
      this.client.reject(id, `Cutroom does not support ${method}.`);
      return;
    }
    const questionsResult = nativeQuestionsSchema.safeParse(params.questions);
    const questions: AgentQuestion[] | undefined = questionsResult.success
      ? questionsResult.data.map((question) => ({
          id: question.id ?? question.question,
          question: question.question,
          options: question.options?.map((option) => option.label) ?? [],
          multiple: question.multiSelect ?? false,
        }))
      : undefined;
    // Only Codex's privileged approval metadata identifies an MCP tool approval.
    // A server's own form or a message mentioning Cutroom never grants edit access.
    const approval =
      method === "mcpServer/elicitation/request"
        ? mcpApprovalSchema.safeParse(params).data
        : undefined;
    const tool = approval
      ? `mcp__${approval.serverName}__${approval._meta.tool_name}`
      : method === "item/commandExecution/requestApproval"
        ? "Shell"
        : method === "item/fileChange/requestApproval"
          ? "Files"
          : method;
    const input = approval?._meta.tool_params ?? params;
    const canAllowCutroomEdits =
      isCutroomEdit(tool) &&
      !codexAsks(this.permissionConfigs, approval?._meta.tool_name ?? "");
    if (canAllowCutroomEdits && this.options.allowCutroomEdits?.()) {
      this.client.respond(id, { action: "accept", content: null });
      return;
    }
    const target = toolTarget(input, this.options.cwd);
    const request: AgentRequest = {
      id: String(id),
      kind: questions ? "question" : "approval",
      tool,
      canAllowCutroomEdits,
      ...(target && { target }),
      title: approval
        ? approvalTitle(tool, input, this.options.cwd)
        : typeof params.reason === "string"
          ? params.reason
          : typeof params.command === "string"
            ? params.command
            : typeof params.message === "string"
              ? params.message
              : "Codex needs your permission",
      input,
      ...(questions ? { questions } : {}),
    };
    const response = await this.options.request(request);
    if (method === "item/tool/requestUserInput") {
      this.client.respond(id, {
        answers: Object.fromEntries(
          (questions ?? []).map((question) => {
            const answer =
              response.decision === "allow"
                ? response.answers?.[question.id]
                : undefined;
            return [
              question.id,
              {
                answers:
                  answer === undefined
                    ? []
                    : typeof answer === "string"
                      ? [answer]
                      : answer,
              },
            ];
          }),
        ),
      });
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.client.respond(id, {
        action: response.decision === "allow" ? "accept" : "decline",
        content: response.answers ?? null,
      });
      return;
    }
    if (method === "item/permissions/requestApproval") {
      this.client.respond(id, {
        permissions:
          response.decision === "allow" ? (params.permissions ?? {}) : {},
        scope: "turn",
      });
      return;
    }
    this.client.respond(id, {
      decision: response.decision === "allow" ? "accept" : "decline",
    });
  }

  async interrupt() {
    this.stopRequested = true;
    if (this.threadId && this.turnId && !this.turnFinished)
      await this.client.call("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.turnId,
      });
  }

  dispose() {
    this.unlisten();
    this.active?.reject(new Error("The conversation was closed."));
  }
}
