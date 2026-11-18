import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentSessionSchema } from "../../shared/agent";
import type {
  AgentCapabilities,
  AgentEvent,
  AgentEventEnvelope,
  AgentProvider,
  AgentRequest,
  AgentResponse,
  AgentSession,
  AgentSessionSummary,
  AgentTurn,
  ConfigureAgentSession,
  CreateAgentSession,
} from "../../shared/agent";
import { HttpError } from "../../shared/errors";
import type { Project } from "../../shared/project";
import type { ProjectStore } from "../projects/store";
import type { ReviewService } from "../projects/review";
import { createNativeRuntimeFactory } from "./factory";
import { isCutroomEdit } from "./tool-permissions";
import { projectNames } from "./tool-subject";
import { completeMessage } from "./runtime";
import type { AgentRuntime, ModelSelection, RuntimeFactory } from "./runtime";
import {
  projectAttachments,
  T3Chats,
  t3AttachmentReceiptsSchema,
} from "./t3-chats";
import type { T3Runner } from "./t3-link";
import { NativeSessions } from "./native-sessions";
import type { NativeSessionInput } from "./native-sessions";
import {
  guardClaudeSession,
  NativeSessionConflict,
} from "./native-session-conflict";

const newChatTitle = "New chat";
const storedSessionSchema = agentSessionSchema.extend({
  customTitle: z.boolean().optional(),
  t3AttachmentReceipts: t3AttachmentReceiptsSchema.optional(),
});
type StoredSession = z.infer<typeof storedSessionSchema>;
type SessionListener = {
  send: (event: AgentEventEnvelope) => void;
  close?: () => void;
};
const storedSessionsSchema = z.object({
  version: z.literal(1),
  sessions: z.array(storedSessionSchema),
  cutroomEdits: z.record(z.string(), z.boolean()).default({}),
});
type PendingRequest = {
  request: AgentRequest;
  resolve: (response: AgentResponse) => void;
  removeAbortListener: () => void;
};
type TurnOperation = {
  kind: "turn";
  phase: "preparing" | "running";
  controller: AbortController;
  queuedId?: string;
  /** Returns this run's claimed review notes to the queue. Safe to call more than once. */
  endReview?: () => Promise<void>;
};
type SessionOperation = TurnOperation | { kind: "configure" };
type FollowUps = NonNullable<AgentSession["queuedTurns"]>;
type FollowUpChange = {
  session: AgentSession;
  apply: (current: FollowUps) => FollowUps;
};
export type AgentServiceOptions = {
  projects: ProjectStore;
  review: ReviewService;
  dataDir: string;
  studioUrl?: string;
  runtimeFactory?: RuntimeFactory;
  t3Runner?: T3Runner;
  nativeSessions?: NativeSessions;
};

export class AgentService {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly operations = new Map<string, SessionOperation>();
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly listeners = new Map<string, Set<SessionListener>>();
  private readonly pendingRequests = new Map<string, PendingRequest[]>();
  private readonly capabilitiesCache = new Map<
    string,
    { expiresAt: number; promise: Promise<AgentCapabilities> }
  >();
  private readonly factory: RuntimeFactory;
  private readonly path: string;
  private readonly t3: T3Chats;
  private readonly nativeSessions: NativeSessions;
  private readonly sequences = new Map<string, number>();
  /** One per conversation, so review actions are bound to that conversation's project and run. */
  private readonly agentTokens = new Map<string, string>();
  private cutroomEdits: Record<string, boolean> = {};
  private readonly runtimePermissions = new Map<string, boolean>();
  private writeChain = Promise.resolve();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private closing?: Promise<void>;

  constructor(private readonly options: AgentServiceOptions) {
    this.path = join(options.dataDir, "agents.json");
    this.t3 = new T3Chats(options.review, options.t3Runner);
    this.nativeSessions = options.nativeSessions ?? new NativeSessions();
    this.factory =
      options.runtimeFactory ?? createNativeRuntimeFactory(options.studioUrl);
  }

  async load() {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    const stored = storedSessionsSchema.parse(JSON.parse(content));
    this.cutroomEdits = stored.cutroomEdits;
    for (const session of stored.sessions) {
      if (
        session.title === "New conversation" &&
        !session.customTitle &&
        !session.messages.length
      )
        session.title = newChatTitle;
      session.runningFollowUpId = undefined;
      if (
        !session.t3Thread &&
        (session.status === "running" || session.status === "waiting")
      ) {
        session.status = "idle";
        session.pendingRequest = undefined;
        for (const message of session.messages)
          if (message.status === "streaming") message.status = "failed";
        session.messages.push(
          completeMessage(
            "The previous run ended when Cutroom closed. Send a message to continue the native session.",
            "system",
          ),
        );
      }
      this.sessions.set(session.id, session);
    }
  }

  private agentToken(id: string) {
    const token = this.agentTokens.get(id) ?? crypto.randomUUID();
    this.agentTokens.set(id, token);
    return token;
  }

  private requireSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, "Chat not found.");
    return session;
  }

  private requireOpen() {
    if (this.disposed)
      throw new HttpError(503, "Cutroom's agent service is closed.");
  }

  async permissions(projectId: string) {
    this.requireOpen();
    await this.options.projects.get(projectId);
    return { alwaysAllowCutroomEdits: this.cutroomEdits[projectId] === true };
  }

  async setPermissions(projectId: string, always: boolean) {
    await this.permissions(projectId);
    const previous = this.cutroomEdits[projectId];
    this.cutroomEdits[projectId] = always;
    try {
      await this.persist();
    } catch (error) {
      this.cutroomEdits[projectId] = previous ?? false;
      throw error;
    }
    // Revocation stops active native sessions too: their native allow entries must not outlive it.
    if (!always)
      for (const session of this.sessions.values()) {
        if (session.projectId !== projectId || session.t3Thread) continue;
        await this.interrupt(session.id).catch((error: unknown) => {
          // Dispose below still closes the native process and its session allow entries.
          console.error(
            `Failed to interrupt agent session ${session.id}; closing it.`,
            error,
          );
        });
        this.runtimes.get(session.id)?.dispose();
        this.runtimes.delete(session.id);
        const operation = this.operations.get(session.id);
        if (operation?.kind === "turn") {
          operation.endReview?.();
          this.releaseTurn(session);
          this.finishStreaming(session.id, "complete");
          this.apply(session.id, { type: "status", status: "idle" });
        }
      }
    await this.persist();
    return { alwaysAllowCutroomEdits: always };
  }

  async capabilities(
    provider: AgentProvider,
    projectId: string,
    refresh = false,
  ) {
    this.requireOpen();
    const project = await this.options.projects.get(projectId);
    this.requireOpen();
    const key = `${provider}:${project.path}`;
    const cached = this.capabilitiesCache.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now())
      return cached.promise;
    const promise = this.factory.capabilities(provider, project.path);
    this.capabilitiesCache.set(key, {
      expiresAt: Date.now() + 60_000,
      promise,
    });
    return promise;
  }

  list(projectId?: string): AgentSessionSummary[] {
    return [...this.sessions.values()]
      .filter((session) => !projectId || session.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(
        ({
          customTitle: _customTitle,
          messages: _messages,
          pendingRequest: _pendingRequest,
          queuedTurns: _queuedTurns,
          runningFollowUpId: _runningFollowUpId,
          t3AttachmentReceipts: _t3AttachmentReceipts,
          ...summary
        }) => summary,
      );
  }

  get(id: string) {
    const {
      customTitle: _customTitle,
      t3AttachmentReceipts: _t3AttachmentReceipts,
      ...session
    } = this.requireSession(id);
    return structuredClone(session);
  }

  async create(input: CreateAgentSession) {
    this.requireOpen();
    await this.options.projects.get(input.projectId);
    this.requireOpen();
    const selection = await this.modelSelection(input, {}, input);
    this.requireOpen();
    const now = new Date().toISOString();
    const session: StoredSession = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      provider: input.provider,
      title: input.title ?? newChatTitle,
      ...(input.title ? { customTitle: true } : {}),
      ...selection,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      messages: [],
    };
    this.sessions.set(session.id, session);
    await this.persist();
    return this.get(session.id);
  }

  async listNativeSessions(projectId: string) {
    this.requireOpen();
    const project = await this.options.projects.get(projectId);
    this.requireOpen();
    const excluded = { claude: new Set<string>(), codex: new Set<string>() };
    for (const session of this.sessions.values()) {
      if (session.nativeSessionId)
        excluded[session.provider].add(session.nativeSessionId);
      if (session.t3Thread)
        excluded[session.provider].add(session.t3Thread.threadId);
    }
    return this.nativeSessions.list(project.path, excluded);
  }

  async openNativeSession(
    projectId: string,
    input: NativeSessionInput,
    mode: "continue" | "branch",
  ) {
    this.requireOpen();
    const project = await this.options.projects.get(projectId);
    this.requireOpen();
    const findOwner = () =>
      [...this.sessions.values()].find(
        (session) =>
          session.provider === input.provider &&
          (session.nativeSessionId === input.sessionId ||
            session.t3Thread?.threadId === input.sessionId),
      );
    const existingContinue = async (session: AgentSession | undefined) => {
      if (session?.t3Thread || (session && session.projectId !== projectId))
        throw new HttpError(
          409,
          "This native chat already belongs to another conversation.",
        );
      if (!session || mode !== "continue") return undefined;
      await this.writeChain;
      return this.get(session.id);
    };
    const owner = findOwner();
    const existing = await existingContinue(owner);
    if (existing) return existing;
    const imported = await this.nativeSessions.open(
      project.path,
      input,
      mode,
      Boolean(owner),
    );
    this.requireOpen();
    // Recheck synchronously before claiming the ID, so concurrent Continue requests share one chat.
    const concurrent = findOwner();
    if (concurrent && concurrent !== owner) {
      const session = await existingContinue(concurrent);
      if (session) return session;
    }
    const session: AgentSession = {
      id: crypto.randomUUID(),
      projectId,
      provider: input.provider,
      nativeSessionId: imported.id,
      nativeImport: { mode, omittedMessages: imported.omittedMessages },
      title: imported.title,
      createdAt: new Date().toISOString(),
      updatedAt: imported.updatedAt,
      status: "idle",
      messages: imported.messages,
    };
    this.sessions.set(session.id, session);
    try {
      await this.persist();
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
    return this.get(session.id);
  }

  async listT3Threads(projectId: string) {
    this.requireOpen();
    return this.t3.list(await this.options.projects.get(projectId));
  }

  async linkT3Thread(projectId: string, threadId: string) {
    this.requireOpen();
    const findLink = () =>
      [...this.sessions.values()].find(
        (session) =>
          session.projectId === projectId &&
          session.t3Thread?.threadId === threadId,
      );
    const existing = findLink();
    if (existing) {
      await this.writeChain;
      return this.get(existing.id);
    }
    const session = await this.t3.open(
      await this.options.projects.get(projectId),
      threadId,
    );
    this.requireOpen();
    const concurrent = findLink();
    if (concurrent) {
      await this.writeChain;
      return this.get(concurrent.id);
    }
    this.sessions.set(session.id, session);
    try {
      await this.persist();
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
    return this.get(session.id);
  }

  async configure(id: string, input: ConfigureAgentSession) {
    this.requireOpen();
    const session = this.requireSession(id);
    const changesModel =
      input.model !== undefined || input.effort !== undefined;
    if (changesModel && session.t3Thread)
      throw new HttpError(409, "Change the model in T3 Code.");
    if (changesModel && this.operations.has(id))
      throw new HttpError(
        409,
        "Stop the current run before changing the model or effort.",
      );
    if (!changesModel) {
      if (input.title === undefined) return this.get(id);
      session.title = input.title;
      session.customTitle = true;
      session.updatedAt = new Date().toISOString();
      await this.persist();
      const updated = this.get(id);
      this.emit(id, { type: "snapshot", session: updated });
      return updated;
    }
    const operation: SessionOperation = { kind: "configure" };
    this.operations.set(id, operation);
    try {
      const selection = await this.modelSelection(session, session, input);
      this.requireOpen();
      this.requireSession(id);
      const sameSelection =
        selection.model === session.model &&
        selection.effort === session.effort;
      if (sameSelection && input.title === undefined) return this.get(id);
      const { model, effort, updatedAt, title, customTitle } = session;
      Object.assign(session, selection, {
        updatedAt: new Date().toISOString(),
      });
      if (input.title !== undefined) {
        session.title = input.title;
        session.customTitle = true;
      }
      try {
        await this.persist();
      } catch (error) {
        Object.assign(session, {
          model,
          effort,
          updatedAt,
          title,
          customTitle,
        });
        throw error;
      }
      if (!sameSelection) {
        const runtime = this.runtimes.get(id);
        if (runtime?.configureModel) runtime.configureModel(selection);
        else {
          this.runtimes.delete(id);
          runtime?.dispose();
        }
      }
      const updated = this.get(id);
      this.emit(id, { type: "snapshot", session: updated });
      return updated;
    } finally {
      if (this.operations.get(id) === operation) this.operations.delete(id);
    }
  }

  async delete(id: string) {
    this.requireOpen();
    const session = this.requireSession(id);
    if (
      this.operations.get(id)?.kind === "turn" ||
      (session.t3Thread &&
        (session.status === "running" || session.status === "waiting")) ||
      session.pendingRequest ||
      this.pendingRequests.get(id)?.length
    )
      throw new HttpError(409, "Stop the run before deleting this chat.");
    this.t3.unwatch(session);
    this.sessions.delete(id);
    try {
      await this.persist();
    } catch (error) {
      this.sessions.set(id, session);
      if (this.listeners.has(id) && !this.disposed)
        this.t3.watch(session, (event) => this.apply(id, event));
      throw error;
    }
    this.runtimes.get(id)?.dispose();
    this.runtimes.delete(id);
    this.runtimePermissions.delete(id);
    this.agentTokens.delete(id);
    this.sequences.delete(id);
    for (const listener of this.listeners.get(id) ?? []) listener.close?.();
    this.listeners.delete(id);
  }

  private async modelSelection(
    conversation: Pick<AgentSession, "provider" | "projectId">,
    previous: ModelSelection,
    input: ConfigureAgentSession,
  ): Promise<ModelSelection> {
    let model = input.model ?? previous.model;
    let effort =
      input.effort === undefined
        ? previous.effort
        : (input.effort ?? undefined);
    const resetModel = input.model === null;
    if (
      !resetModel &&
      (effort === undefined ||
        (model === previous.model && input.effort === undefined))
    )
      return { model, effort };

    const capabilities = await this.capabilities(
      conversation.provider,
      conversation.projectId,
      resetModel,
    );
    const selected = capabilities.models.find((candidate) =>
      resetModel || model === undefined
        ? candidate.isDefault
        : candidate.id === model,
    );
    if (!capabilities.available && capabilities.models.length === 0)
      throw new HttpError(
        503,
        capabilities.error ?? "The native agent is unavailable.",
      );
    if (resetModel) {
      if (!selected)
        throw new HttpError(
          503,
          "The native default model could not be discovered. Choose a model from the list.",
        );
      model = selected.id;
    }
    if (effort !== undefined && !selected?.efforts.includes(effort)) {
      if (input.effort !== undefined)
        throw new HttpError(
          400,
          `${selected?.name ?? model ?? "The default model"} does not offer the effort ${effort}.`,
        );
      effort = undefined;
    }
    return { model, effort };
  }

  async send(id: string, turn: AgentTurn) {
    this.requireOpen();
    const session = this.requireSession(id);
    if (session.t3Thread) {
      const project = await this.options.projects.get(session.projectId);
      this.requireOpen();
      const result = await this.t3
        .send(project, session.t3Thread.threadId, session, turn)
        .finally(() =>
          this.persist().catch((error) => this.storageFailed(error)),
        );
      return { ...this.get(id), ...result };
    }
    if (session.queuedTurns?.length)
      throw new HttpError(409, "Resume the queued follow-ups first.");
    return this.runTurn(session, turn);
  }

  async queueFollowUp(id: string, turn: AgentTurn) {
    this.requireOpen();
    const session = this.requireSession(id);
    if (session.t3Thread) return this.send(id, turn);
    const entry = { id: crypto.randomUUID(), turn };
    return this.changeFollowUps(session, (current) => [...current, entry]);
  }

  async removeFollowUp(id: string, queuedId: string) {
    this.requireOpen();
    const session = this.requireSession(id);
    return this.changeFollowUps(session, (current) => {
      const operation = this.operations.get(id);
      if (operation?.kind === "turn" && operation.queuedId === queuedId)
        throw new HttpError(409, "This follow-up is already starting.");
      const remaining = current.filter(({ id }) => id !== queuedId);
      if (remaining.length === current.length)
        throw new HttpError(404, "Follow-up not found.");
      return remaining;
    });
  }

  private async changeFollowUps(
    session: AgentSession,
    change: (current: FollowUps) => FollowUps,
  ) {
    await this.persist({ session, apply: change });
    return this.get(session.id);
  }

  private publishFollowUps(session: AgentSession) {
    this.emit(session.id, {
      type: "turn-queue",
      turns: session.queuedTurns ?? [],
      runningId: session.runningFollowUpId,
    });
  }

  async resumeFollowUps(id: string) {
    this.requireOpen();
    const session = this.requireSession(id);
    const next = session.queuedTurns?.[0];
    return next ? this.runTurn(session, next.turn, next.id) : this.get(id);
  }

  private async runTurn(
    session: StoredSession,
    turn: AgentTurn,
    queuedId?: string,
  ) {
    const { id } = session;
    if (this.operations.has(id))
      throw new HttpError(409, "This agent is working. Wait for it to finish.");
    // Review claims and withdrawals belong to the one run working on the project.
    for (const [other, running] of this.operations)
      if (
        running.kind === "turn" &&
        this.sessions.get(other)?.projectId === session.projectId
      )
        throw new HttpError(
          409,
          "A conversation in this project is already working. Stop it or wait for it to finish.",
        );
    const operation: TurnOperation = {
      kind: "turn",
      phase: "preparing",
      controller: new AbortController(),
      queuedId,
    };
    this.operations.set(id, operation);
    if (queuedId) {
      session.runningFollowUpId = queuedId;
      this.publishFollowUps(session);
      if (session.status !== "running")
        this.apply(id, { type: "status", status: "running" });
    }
    try {
      return await this.startTurn(session, turn, operation);
    } catch (error) {
      await operation.endReview?.();
      if (this.admissionCancelled(id, operation)) return this.get(id);
      this.releaseTurn(session);
      if (!this.disposed && this.requireSession(id).status === "running")
        this.apply(id, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof NativeSessionConflict
            ? { code: error.code }
            : {}),
        });
      throw error;
    }
  }

  private releaseTurn(session: AgentSession) {
    this.operations.delete(session.id);
    if (session.runningFollowUpId) {
      session.runningFollowUpId = undefined;
      this.publishFollowUps(session);
    }
  }

  private admissionCancelled(id: string, operation: TurnOperation) {
    if (
      !operation.controller.signal.aborted &&
      !this.disposed &&
      this.operations.get(id) === operation
    )
      return false;
    if (this.operations.get(id) !== operation) return true;
    const session = this.requireSession(id);
    this.releaseTurn(session);
    if (!this.disposed && session.status === "running")
      this.apply(id, { type: "status", status: "idle" });
    return true;
  }

  private prepare<T>(operation: TurnOperation, work: Promise<T>): Promise<T> {
    const signal = operation.controller.signal;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        signal.removeEventListener("abort", cancel);
        reject(signal.reason);
      };
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", cancel);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", cancel);
          reject(error);
        },
      );
    });
  }

  private async startTurn(
    session: StoredSession,
    turn: AgentTurn,
    operation: TurnOperation,
  ) {
    const id = session.id;
    const project = await this.prepare(
      operation,
      this.options.projects.get(session.projectId),
    );
    if (this.admissionCancelled(id, operation)) return this.get(id);
    const capabilities = turn.skills.length
      ? await this.prepare(
          operation,
          this.capabilities(session.provider, session.projectId),
        )
      : undefined;
    if (this.admissionCancelled(id, operation)) return this.get(id);
    if (capabilities && !capabilities.available)
      throw new HttpError(
        503,
        capabilities.error ?? "The native agent is unavailable.",
      );
    const skills = turn.skills.map((selected) => {
      const skill = capabilities?.skills.find(
        (candidate) =>
          candidate.enabled &&
          candidate.name === selected.name &&
          (!selected.path || candidate.path === selected.path),
      );
      if (!skill)
        throw new HttpError(
          400,
          `The skill ${selected.name} is unavailable. Refresh the skill list and select it again.`,
        );
      return { name: skill.name, ...(skill.path ? { path: skill.path } : {}) };
    });
    const attachments = await this.prepare(
      operation,
      projectAttachments(project, turn),
    );
    const nativeTurn = { ...turn, skills, attachments };
    if (this.admissionCancelled(id, operation)) return this.get(id);
    const continuedClaudeId =
      session.provider === "claude" && session.nativeImport?.mode === "continue"
        ? session.nativeSessionId
        : undefined;
    if (continuedClaudeId) {
      const changedAt = await this.prepare(
        operation,
        this.nativeSessions.claudeChangedAt(project.path, continuedClaudeId),
      );
      if (this.admissionCancelled(id, operation)) return this.get(id);
      guardClaudeSession(changedAt, session.nativeImport?.lastOwnWrite);
    }
    const preparedRuntime =
      session.provider === "codex" && session.nativeImport
        ? this.runtime(session, project)
        : undefined;
    if (preparedRuntime?.prepare) {
      try {
        await this.prepare(operation, preparedRuntime.prepare());
      } catch (error) {
        if (this.runtimes.get(id) === preparedRuntime) {
          this.runtimes.delete(id);
          preparedRuntime.dispose();
        }
        if (error instanceof HttpError || operation.controller.signal.aborted)
          throw error;
        throw new HttpError(503, "Could not open this chat in Codex.");
      }
      if (this.admissionCancelled(id, operation)) return this.get(id);
    }
    if (
      !session.nativeImport &&
      session.title === newChatTitle &&
      !session.customTitle &&
      !session.messages.some((message) => message.role === "user")
    )
      session.title = turn.text.trim().slice(0, 90) || "Attached media";
    const message = {
      ...completeMessage(
        turn.text || "Attached media",
        "user",
        operation.queuedId,
      ),
      ...(attachments.length > 0 && { attachments }),
    };
    if (!operation.queuedId) {
      this.apply(id, { type: "message", message });
      this.apply(id, { type: "status", status: "running" });
    }
    await this.persist();
    if (this.admissionCancelled(id, operation)) {
      if (!this.disposed) await this.persist();
      return this.get(id);
    }
    if (
      operation.queuedId &&
      !session.queuedTurns?.some(({ id }) => id === operation.queuedId)
    )
      throw new HttpError(409, "This follow-up was removed before it started.");
    const review = await this.options.review.beginTurn(project, {
      id: message.id,
      kind: "message",
      token: this.agentToken(id),
      name: session.provider === "codex" ? "Codex" : "Claude",
    });
    const endReview = (operation.endReview = async () => {
      if (this.disposed) return;
      await review.end().catch((error: unknown) => {
        console.error(
          "Review notes could not be returned to the queue:",
          error,
        );
      });
    });
    if (this.admissionCancelled(id, operation)) {
      await endReview();
      if (!this.disposed) await this.persist();
      return this.get(id);
    }
    operation.phase = "running";
    const native = preparedRuntime ?? this.runtime(session, project);
    if (operation.queuedId) this.apply(id, { type: "message", message });
    void native
      .send({
        ...nativeTurn,
        context:
          [review.digest, turn.context].filter(Boolean).join("\n\n") ||
          undefined,
      })
      .finally(async () => {
        if (!continuedClaudeId || this.runtimes.get(id) !== native) return;
        // Reopen on the next turn so Claude sees writes made outside this query.
        this.runtimes.delete(id);
        if (!native.closeAfterTurn) {
          native.dispose();
          return;
        }
        if (!(await native.closeAfterTurn())) return;
        const saved = await this.nativeSessions
          .claudeChangedAt(project.path, continuedClaudeId)
          .catch(() => undefined);
        if (saved !== undefined && session.nativeImport)
          session.nativeImport.lastOwnWrite = saved;
      })
      .then(async () => {
        await endReview();
        if (this.disposed || this.operations.get(id) !== operation) return;
        // Keep an interrupted follow-up available for the owner to resume or remove.
        if (
          operation.queuedId &&
          !operation.controller.signal.aborted &&
          session.status !== "error"
        )
          await this.changeFollowUps(session, (current) =>
            current.filter(({ id }) => id !== operation.queuedId),
          );
        await this.writeChain.catch(() => {});
        if (this.disposed || this.operations.get(id) !== operation) return;
        this.finishStreaming(id, "complete");
        this.rejectRequests(id);
        this.releaseTurn(session);
        const succeeded = session.status !== "error";
        const next =
          succeeded && !operation.controller.signal.aborted
            ? session.queuedTurns?.[0]
            : undefined;
        if (next)
          await this.runTurn(session, next.turn, next.id).catch(() => {
            // runTurn has already set the conversation error for this admission.
          });
        else if (succeeded) this.apply(id, { type: "status", status: "idle" });
        void this.persist().catch((error) => this.storageFailed(error));
      })
      .catch(async (error) => {
        await endReview();
        if (this.disposed || this.operations.get(id) !== operation) return;
        this.finishStreaming(id, "failed");
        this.rejectRequests(id);
        if (this.runtimes.get(id) === native) {
          this.runtimes.delete(id);
          native.dispose();
        }
        this.releaseTurn(session);
        if (session.status !== "error")
          this.apply(id, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        void this.persist().catch((failure) => this.storageFailed(failure));
      });
    return this.get(id);
  }

  private runtime(session: AgentSession, project: Project) {
    const { id } = session;
    let runtime = this.runtimes.get(id);
    const always = this.cutroomEdits[session.projectId] === true;
    if (runtime && this.runtimePermissions.get(id) !== always) {
      runtime.dispose();
      this.runtimes.delete(id);
      runtime = undefined;
    }
    if (!runtime) {
      this.runtimePermissions.set(id, always);
      runtime = this.factory.create(session.provider, {
        cwd: project.path,
        model: session.model,
        effort: session.effort,
        nativeSessionId: session.nativeSessionId,
        agentToken: this.agentToken(id),
        allowCutroomEdits: () => this.cutroomEdits[session.projectId] === true,
        names: projectNames(
          this.options.projects,
          this.options.review,
          project,
        ),
        emit: (event) => {
          if (this.disposed || !runtime || this.runtimes.get(id) !== runtime)
            return;
          if (event.type === "error") {
            this.finishStreaming(id, "failed");
            this.rejectRequests(id);
            this.runtimes.delete(id);
            runtime.dispose();
          }
          this.apply(id, event);
        },
        request: (request, signal) =>
          runtime && this.runtimes.get(id) === runtime
            ? this.request(id, request, signal)
            : Promise.resolve({ requestId: request.id, decision: "deny" }),
      });
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  async interrupt(id: string) {
    this.requireOpen();
    const session = this.requireSession(id);
    if (session.t3Thread) throw new HttpError(409, "Stop this run in T3 Code.");
    const operation = this.operations.get(id);
    if (operation?.kind === "turn") {
      operation.controller.abort();
      if (operation.phase === "preparing") {
        if (!operation.queuedId) this.admissionCancelled(id, operation);
        return this.get(id);
      }
    }
    this.rejectRequests(id);
    const runtime = this.runtimes.get(id);
    if (
      runtime &&
      (session.status === "running" || session.status === "waiting")
    )
      await runtime.interrupt();
    return this.get(id);
  }

  async respond(id: string, response: AgentResponse) {
    this.requireOpen();
    const session = this.requireSession(id);
    if (session.t3Thread) throw new HttpError(409, "Answer in T3 Code.");
    const operation = this.operations.get(id);
    const queue = this.pendingRequests.get(id) ?? [];
    const current = queue[0];
    if (!current || current.request.id !== response.requestId)
      throw new HttpError(
        409,
        "This request has already been answered or cancelled.",
      );
    if (response.alwaysAllowCutroomEdits) {
      if (
        response.decision !== "allow" ||
        !current.request.canAllowCutroomEdits ||
        !isCutroomEdit(current.request.tool)
      )
        throw new HttpError(
          400,
          "Always allow applies only to Cutroom edit approvals.",
        );
      await this.setPermissions(session.projectId, true);
      if (
        queue[0] !== current ||
        operation?.kind !== "turn" ||
        operation.controller.signal.aborted
      )
        throw new HttpError(409, "This request was cancelled.");
    }
    queue.shift();
    current.removeAbortListener();
    session.pendingRequest = undefined;
    this.emit(id, { type: "request-resolved", requestId: response.requestId });
    const next = queue[0];
    if (next) this.apply(id, { type: "request", request: next.request });
    else this.apply(id, { type: "status", status: "running" });
    try {
      await this.persist();
      current.resolve(
        operation?.kind === "turn" && operation.controller.signal.aborted
          ? { requestId: response.requestId, decision: "deny" }
          : response,
      );
    } catch (error) {
      current.resolve({ requestId: response.requestId, decision: "deny" });
      throw error;
    }
    return this.get(id);
  }

  private request(id: string, request: AgentRequest, signal?: AbortSignal) {
    return new Promise<AgentResponse>((resolve) => {
      const operation = this.operations.get(id);
      if (
        signal?.aborted ||
        this.disposed ||
        operation?.kind !== "turn" ||
        operation.phase !== "running" ||
        operation.controller.signal.aborted
      ) {
        resolve({ requestId: request.id, decision: "deny" });
        return;
      }
      const queue = this.pendingRequests.get(id) ?? [];
      const onAbort = () => this.cancelRequest(id, request.id);
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push({
        request,
        resolve,
        removeAbortListener: () =>
          signal?.removeEventListener("abort", onAbort),
      });
      this.pendingRequests.set(id, queue);
      if (queue.length === 1) this.apply(id, { type: "request", request });
    });
  }

  private cancelRequest(id: string, requestId: string) {
    const queue = this.pendingRequests.get(id) ?? [];
    const index = queue.findIndex(
      (pending) => pending.request.id === requestId,
    );
    const pending = queue[index];
    if (!pending) return;
    queue.splice(index, 1);
    pending.removeAbortListener();
    pending.resolve({ requestId, decision: "deny" });
    if (index !== 0) return;
    this.requireSession(id).pendingRequest = undefined;
    this.emit(id, { type: "request-resolved", requestId });
    if (queue[0])
      this.apply(id, { type: "request", request: queue[0].request });
    else this.apply(id, { type: "status", status: "running" });
  }

  private rejectRequests(id: string) {
    const queue = this.pendingRequests.get(id) ?? [];
    this.pendingRequests.delete(id);
    for (const pending of queue) {
      pending.removeAbortListener();
      pending.resolve({ requestId: pending.request.id, decision: "deny" });
      this.emit(id, {
        type: "request-resolved",
        requestId: pending.request.id,
      });
    }
    this.requireSession(id).pendingRequest = undefined;
    if (!this.disposed && this.requireSession(id).status === "waiting")
      this.apply(id, { type: "status", status: "running" });
  }

  subscribe(id: string, send: SessionListener["send"], close?: () => void) {
    const session = this.requireSession(id);
    const listeners = this.listeners.get(id) ?? new Set<SessionListener>();
    const listener = { send, close };
    listeners.add(listener);
    this.listeners.set(id, listeners);
    send({
      seq: this.sequences.get(id) ?? 0,
      event: { type: "snapshot", session: this.get(id) },
    });
    if (!this.disposed)
      this.t3.watch(session, (event) => this.apply(id, event));
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        this.listeners.delete(id);
        this.t3.unwatch(session);
      }
    };
  }

  private finishStreaming(id: string, status: "complete" | "failed") {
    for (const message of this.requireSession(id).messages) {
      if (message.status !== "streaming") continue;
      message.status = status;
      this.emit(id, { type: "message", message: { ...message } });
    }
  }

  private apply(id: string, event: AgentEvent) {
    if (this.disposed) return;
    const session = this.requireSession(id);
    session.updatedAt = new Date().toISOString();
    if (event.type === "message") {
      const index = session.messages.findIndex(
        (message) => message.id === event.message.id,
      );
      if (index < 0) session.messages.push(event.message);
      else
        session.messages[index] = {
          ...event.message,
          createdAt:
            session.messages[index]?.createdAt ?? event.message.createdAt,
        };
    }
    if (event.type === "delta") {
      const message = session.messages.find(
        (message) => message.id === event.messageId,
      );
      if (message) {
        message.text += event.text;
        message.status = "streaming";
      }
    }
    if (event.type === "status") session.status = event.status;
    if (event.type === "native-session")
      session.nativeSessionId = event.nativeSessionId;
    if (event.type === "request") {
      session.pendingRequest = event.request;
      session.status = "waiting";
      this.emit(id, { type: "status", status: "waiting" });
    }
    if (event.type === "error") {
      session.status = "error";
      const message = completeMessage(event.message, "system");
      session.messages.push(message);
      this.emit(id, { type: "message", message });
      this.emit(id, { type: "status", status: "error" });
    }
    this.emit(id, event);
    this.scheduleSave();
  }

  private emit(id: string, event: AgentEvent) {
    const seq = (this.sequences.get(id) ?? 0) + 1;
    this.sequences.set(id, seq);
    for (const listener of this.listeners.get(id) ?? [])
      listener.send({ seq, event });
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.persist().catch((error) => this.storageFailed(error));
    }, 500);
  }

  private storageFailed(error: unknown) {
    const message = `Chat history could not be saved: ${error instanceof Error ? error.message : String(error)}`;
    for (const session of this.sessions.values()) {
      this.emit(session.id, { type: "error", message });
      if (!this.operations.has(session.id)) {
        session.status = "error";
        this.emit(session.id, { type: "status", status: "error" });
      }
    }
  }

  private persist(change?: FollowUpChange) {
    const write = async () => {
      const turns = change?.apply(change.session.queuedTurns ?? []);
      const content = JSON.stringify({
        version: 1,
        sessions: [...this.sessions.values()].map((session) =>
          change?.session === session
            ? { ...session, queuedTurns: turns }
            : session,
        ),
        cutroomEdits: this.cutroomEdits,
      });
      await mkdir(this.options.dataDir, { recursive: true });
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, this.path);
      if (
        change &&
        turns &&
        this.sessions.get(change.session.id) === change.session
      ) {
        change.session.queuedTurns = turns;
        this.publishFollowUps(change.session);
      }
    };
    this.writeChain = this.writeChain.then(write, write);
    return this.writeChain;
  }

  dispose() {
    this.closing ??= this.close();
    return this.closing;
  }

  private async close() {
    this.disposed = true;
    this.t3.close();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const operation of this.operations.values())
      if (operation.kind === "turn") operation.controller.abort();
    for (const id of this.pendingRequests.keys()) this.rejectRequests(id);
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
    this.factory.dispose();
    await this.persist();
  }
}

export async function createAgentService(options: AgentServiceOptions) {
  const service = new AgentService(options);
  await service.load();
  return service;
}
