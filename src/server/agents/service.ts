import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
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
import { projectPath } from "../projects/store";
import type { ProjectStore } from "../projects/store";
import { createNativeRuntimeFactory } from "./factory";
import { completeMessage } from "./runtime";
import type { AgentRuntime, RuntimeFactory } from "./runtime";

const storedSessionsSchema = z.object({
  version: z.literal(1),
  sessions: z.array(agentSessionSchema),
});
type PendingRequest = {
  request: AgentRequest;
  resolve: (response: AgentResponse) => void;
  removeAbortListener: () => void;
};
export type AgentServiceOptions = {
  projects: ProjectStore;
  dataDir: string;
  studioUrl?: string;
  runtimeFactory?: RuntimeFactory;
};

export class AgentService {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly admissions = new Set<string>();
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly listeners = new Map<
    string,
    Set<(event: AgentEventEnvelope) => void>
  >();
  private readonly pendingRequests = new Map<string, PendingRequest[]>();
  private readonly capabilitiesCache = new Map<
    string,
    { expiresAt: number; promise: Promise<AgentCapabilities> }
  >();
  private readonly factory: RuntimeFactory;
  private readonly path: string;
  private readonly sequences = new Map<string, number>();
  private writeChain = Promise.resolve();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly options: AgentServiceOptions) {
    this.path = join(options.dataDir, "agents.json");
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
    for (const session of stored.sessions) {
      if (session.status === "running" || session.status === "waiting") {
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

  private requireSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, "Conversation not found.");
    return session;
  }

  async capabilities(
    provider: AgentProvider,
    projectId: string,
    refresh = false,
  ) {
    const project = await this.options.projects.get(projectId);
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
          messages: _messages,
          pendingRequest: _pendingRequest,
          ...summary
        }) => summary,
      );
  }

  get(id: string) {
    return structuredClone(this.requireSession(id));
  }

  async create(input: CreateAgentSession) {
    await this.options.projects.get(input.projectId);
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      provider: input.provider,
      title: input.title ?? "New conversation",
      ...(input.model ? { model: input.model } : {}),
      createdAt: now,
      updatedAt: now,
      status: "idle",
      messages: [],
    };
    this.sessions.set(session.id, session);
    await this.persist();
    return this.get(session.id);
  }

  async configure(id: string, input: ConfigureAgentSession) {
    const session = this.requireSession(id);
    if (
      this.admissions.has(id) ||
      session.status === "running" ||
      session.status === "waiting"
    )
      throw new HttpError(409, "Stop the current run before changing models.");
    this.admissions.add(id);
    try {
      if (input.model === undefined || input.model === session.model)
        return this.get(id);
      let model = input.model;
      if (model === null) {
        const capabilities = await this.capabilities(
          session.provider,
          session.projectId,
          true,
        );
        const configured = capabilities.models.find(
          (candidate) => candidate.isDefault,
        );
        if (!configured)
          throw new HttpError(
            503,
            "The native default model could not be discovered. Choose a model from the list.",
          );
        model = configured.id;
      }
      this.runtimes.get(id)?.dispose();
      this.runtimes.delete(id);
      session.model = model;
      session.updatedAt = new Date().toISOString();
      await this.persist();
      this.emit(id, { type: "snapshot", session: structuredClone(session) });
      return this.get(id);
    } finally {
      this.admissions.delete(id);
    }
  }

  async send(id: string, turn: AgentTurn) {
    const session = this.requireSession(id);
    if (
      this.admissions.has(id) ||
      session.status === "running" ||
      session.status === "waiting"
    )
      throw new HttpError(
        409,
        "This agent is working. Stop it before sending another request.",
      );
    this.admissions.add(id);
    try {
      return await this.startTurn(session, turn);
    } catch (error) {
      if (this.requireSession(id).status === "running")
        this.apply(id, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      throw error;
    } finally {
      this.admissions.delete(id);
    }
  }

  private async startTurn(session: AgentSession, turn: AgentTurn) {
    const id = session.id;
    const project = await this.options.projects.get(session.projectId);
    const capabilities = turn.skills.length
      ? await this.capabilities(session.provider, session.projectId)
      : undefined;
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
    const attachments = await Promise.all(
      turn.attachments.map(async (attachment) => {
        if (!isAbsolute(attachment.path))
          throw new HttpError(
            400,
            "Attachments must use an absolute project file path.",
          );
        return {
          ...attachment,
          path: await projectPath(
            project,
            relative(project.path, attachment.path),
          ),
        };
      }),
    );
    const nativeTurn = { ...turn, skills, attachments };
    if (!session.messages.some((message) => message.role === "user"))
      session.title = turn.text.trim().slice(0, 90) || "Attached media";
    this.apply(id, {
      type: "message",
      message: completeMessage(turn.text || "Attached media", "user"),
    });
    this.apply(id, { type: "status", status: "running" });
    await this.persist();
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = this.factory.create(session.provider, {
        cwd: project.path,
        model: session.model,
        nativeSessionId: session.nativeSessionId,
        emit: (event) => {
          this.apply(id, event);
          if (event.type === "error") {
            this.runtimes.get(id)?.dispose();
            this.runtimes.delete(id);
          }
        },
        request: (request, signal) => this.request(id, request, signal),
      });
      this.runtimes.set(id, runtime);
    }
    const native = runtime;
    void native
      .send(nativeTurn)
      .then(async () => {
        if (this.disposed) return;
        this.finishStreaming(id, "complete");
        this.apply(id, { type: "status", status: "idle" });
        await this.persist();
      })
      .catch(async (error) => {
        if (this.disposed) return;
        this.finishStreaming(id, "failed");
        this.rejectRequests(id);
        native.dispose();
        this.runtimes.delete(id);
        this.apply(id, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        try {
          await this.persist();
        } catch (failure) {
          this.storageFailed(failure);
        }
      });
    return this.get(id);
  }

  async interrupt(id: string) {
    const session = this.requireSession(id);
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
    const session = this.requireSession(id);
    const queue = this.pendingRequests.get(id) ?? [];
    const current = queue[0];
    if (!current || current.request.id !== response.requestId)
      throw new HttpError(
        409,
        "This request has already been answered or cancelled.",
      );
    queue.shift();
    current.removeAbortListener();
    session.pendingRequest = undefined;
    this.emit(id, { type: "request-resolved", requestId: response.requestId });
    const next = queue[0];
    if (next) this.apply(id, { type: "request", request: next.request });
    else this.apply(id, { type: "status", status: "running" });
    await this.persist();
    current.resolve(response);
    return this.get(id);
  }

  private request(id: string, request: AgentRequest, signal?: AbortSignal) {
    return new Promise<AgentResponse>((resolve) => {
      if (signal?.aborted || this.disposed) {
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
  }

  subscribe(id: string, listener: (event: AgentEventEnvelope) => void) {
    const session = this.requireSession(id);
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    listener({
      seq: this.sequences.get(id) ?? 0,
      event: { type: "snapshot", session: structuredClone(session) },
    });
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
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
      listener({ seq, event });
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.persist().catch((error) => this.storageFailed(error));
    }, 500);
  }

  private storageFailed(error: unknown) {
    const message = `Conversation history could not be saved: ${error instanceof Error ? error.message : String(error)}`;
    for (const session of this.sessions.values()) {
      session.status = "error";
      this.emit(session.id, { type: "error", message });
      this.emit(session.id, { type: "status", status: "error" });
    }
  }

  private persist() {
    const content = JSON.stringify({
      version: 1,
      sessions: [...this.sessions.values()],
    });
    const write = async () => {
      await mkdir(this.options.dataDir, { recursive: true });
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, this.path);
    };
    this.writeChain = this.writeChain.then(write, write);
    return this.writeChain;
  }

  async dispose() {
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
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
