import { z } from "zod";

export const agentProviderSchema = z.enum(["codex", "claude"]);
export type AgentProvider = z.infer<typeof agentProviderSchema>;

export const agentSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string().optional(),
  scope: z.string().optional(),
  enabled: z.boolean().default(true),
});
export type AgentSkill = z.infer<typeof agentSkillSchema>;

export const agentModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
});
export type AgentModel = z.infer<typeof agentModelSchema>;

export const agentCapabilitiesSchema = z.object({
  provider: agentProviderSchema,
  available: z.boolean(),
  version: z.string().optional(),
  skills: z.array(agentSkillSchema),
  models: z.array(agentModelSchema),
  mcpServers: z
    .array(z.object({ name: z.string(), status: z.string() }))
    .default([]),
  error: z.string().optional(),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

export const agentMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool", "system"]),
  text: z.string(),
  createdAt: z.string(),
  status: z.enum(["streaming", "complete", "failed"]).default("complete"),
  tool: z.string().optional(),
  /** What a tool call acted on, such as a file path or command, kept after its result arrives. */
  target: z.string().optional(),
  /** What a finished edit did, in the editor's words; it replaces the verb and target. */
  summary: z.string().optional(),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

const targetKeys = [
  "file_path",
  "notebook_path",
  "path",
  "mediaPath",
  "sourceFile",
  "composition",
  "compositionPath",
  "elementId",
  "transcriptId",
  "annotationId",
  "command",
  "pattern",
  "url",
  "query",
  "description",
] as const;

/**
 * The first line of the input field that names what a tool call acts on, with paths inside
 * the project written relative to it: `/home/me/cut/index.html` reads as `index.html`.
 */
export function toolTarget(
  input: unknown,
  project: string,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const root = project.replace(/\/+$/, "");
  for (const key of targetKeys) {
    const value: unknown = Reflect.get(input, key);
    if (typeof value !== "string" || !value.trim()) continue;
    const line = value.trim().split("\n", 1)[0] ?? "";
    return line === root ? "." : line.replaceAll(`${root}/`, "");
  }
  return undefined;
}

export const agentQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()).default([]),
  multiple: z.boolean().default(false),
});
export type AgentQuestion = z.infer<typeof agentQuestionSchema>;

export const agentRequestSchema = z.object({
  id: z.string(),
  kind: z.enum(["approval", "question"]),
  /** The request as a short question, naming what it acts on the way the editor does. */
  title: z.string(),
  /** One more line the owner needs to decide, such as how many changes an edit makes. */
  detail: z.string().optional(),
  /** The tool's own identifier. Shown only with the raw request, never in the question. */
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** What the tool would act on, relative to the project, as on tool rows. */
  target: z.string().optional(),
  questions: z.array(agentQuestionSchema).optional(),
  canAllowCutroomEdits: z.boolean().optional(),
});
export type AgentRequest = z.infer<typeof agentRequestSchema>;

export const agentStatusSchema = z.enum([
  "idle",
  "running",
  "waiting",
  "error",
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentSessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: agentProviderSchema,
  title: z.string(),
  model: z.string().optional(),
  nativeSessionId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: agentStatusSchema,
  messages: z.array(agentMessageSchema),
  pendingRequest: agentRequestSchema.optional(),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;
export const agentSessionSummarySchema = agentSessionSchema.omit({
  messages: true,
  pendingRequest: true,
});
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>;

export const createAgentSessionSchema = z.object({
  projectId: z.string().min(1),
  provider: agentProviderSchema,
  model: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(160).optional(),
});
export type CreateAgentSession = z.infer<typeof createAgentSessionSchema>;

export const configureAgentSessionSchema = z.object({
  model: z.string().trim().min(1).nullable().optional(),
});
export type ConfigureAgentSession = z.infer<typeof configureAgentSessionSchema>;

export const agentTurnSchema = z
  .object({
    text: z.string().max(200_000),
    skills: z
      .array(z.object({ name: z.string().min(1), path: z.string().optional() }))
      .max(30)
      .default([]),
    attachments: z
      .array(
        z.object({ path: z.string().min(1), mimeType: z.string().optional() }),
      )
      .max(30)
      .default([]),
    context: z.string().max(100_000).optional(),
  })
  .refine(
    (value) => value.text.trim().length > 0 || value.attachments.length > 0,
    "Write a message or attach a file.",
  );
export type AgentTurn = z.infer<typeof agentTurnSchema>;

export const agentPermissionsSchema = z.object({
  alwaysAllowCutroomEdits: z.boolean(),
});

export const agentResponseSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
  alwaysAllowCutroomEdits: z.boolean().optional(),
  answers: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), session: agentSessionSchema }),
  z.object({ type: z.literal("message"), message: agentMessageSchema }),
  z.object({
    type: z.literal("delta"),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({ type: z.literal("status"), status: agentStatusSchema }),
  z.object({ type: z.literal("request"), request: agentRequestSchema }),
  z.object({ type: z.literal("request-resolved"), requestId: z.string() }),
  z.object({ type: z.literal("native-session"), nativeSessionId: z.string() }),
  z.object({
    type: z.literal("capabilities"),
    capabilities: agentCapabilitiesSchema,
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
export const agentEventEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative(),
  event: agentEventSchema,
});
export type AgentEventEnvelope = z.infer<typeof agentEventEnvelopeSchema>;
