import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import { agentAttachmentSchema } from "../../shared/agent";
import type { AgentEvent, AgentSession, AgentTurn } from "../../shared/agent";
import { HttpError } from "../../shared/errors";
import type { Project } from "../../shared/project";
import { unfinishedStatuses } from "../../shared/review";
import { projectPath } from "../projects/path";
import { ReviewFileError, reviewDigest } from "../projects/review";
import type { ReviewService } from "../projects/review";
import { agentPrompt, completeMessage } from "./runtime";
import { T3Link, threadMessages, threadStatus } from "./t3-link";
import type { T3Runner } from "./t3-link";

const workingPollMs = 12_000;
const idlePollMs = 30_000;
const afterSendPollMs = [2_000, 4_000, 8_000];

export const t3AttachmentReceiptsSchema = z.array(
  z.object({
    promptHash: z.string(),
    attachments: z.array(agentAttachmentSchema),
  }),
);
type LinkedSession = AgentSession & {
  t3AttachmentReceipts?: z.infer<typeof t3AttachmentReceiptsSchema>;
};

const hashPrompt = (text: string) =>
  createHash("sha256").update(text.trim()).digest("hex");

export function projectAttachments(project: Project, turn: AgentTurn) {
  return Promise.all(
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
}

export class T3Chats {
  private readonly cli: T3Link;
  private readonly watches = new Map<
    string,
    {
      sessions: Map<
        string,
        { session: LinkedSession; emit: (event: AgentEvent) => void }
      >;
      stop: () => void;
      afterSend: () => void;
    }
  >();

  constructor(
    private readonly review: ReviewService,
    runner?: T3Runner,
  ) {
    this.cli = new T3Link(runner);
  }

  async list(project: Project) {
    try {
      return { available: true, threads: await this.cli.list(project.path) };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return { available: false, threads: [], reason: error.message };
    }
  }

  async open(project: Project, id: string): Promise<AgentSession> {
    const snapshot = await this.cli.show(id);
    const { thread } = snapshot;
    const session: AgentSession = {
      id: crypto.randomUUID(),
      projectId: project.id,
      provider:
        /claude/i.test(thread.providerInstanceId) ||
        thread.model.startsWith("claude-")
          ? "claude"
          : "codex",
      title: thread.title,
      t3Thread: { threadId: thread.threadId },
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: threadStatus(thread),
      messages: threadMessages(snapshot),
    };
    if (session.status === "waiting")
      session.messages.push(completeMessage("Answer in T3 Code.", "system"));
    return session;
  }

  watch(session: LinkedSession, emit: (event: AgentEvent) => void) {
    const id = session.t3Thread?.threadId;
    if (!id) return;
    const existingWatch = this.watches.get(id);
    if (existingWatch) {
      existingWatch.sessions.set(session.id, { session, emit });
      return;
    }
    const sessions = new Map([[session.id, { session, emit }]]);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastError: string | undefined;
    let polling = false;
    let earlyReads: number[] = [];
    const poll = async () => {
      polling = true;
      const startedAt = performance.now();
      let interval = idlePollMs;
      try {
        const snapshot = await this.cli.show(id, controller.signal);
        if (controller.signal.aborted) return;
        lastError = undefined;
        const status = threadStatus(snapshot.thread);
        if (status === "running") interval = workingPollMs;
        for (const { session, emit } of sessions.values()) {
          const previous = new Map(
            session.messages.map((message) => [message.id, message]),
          );
          for (const message of threadMessages(snapshot, session.messages)) {
            const existing = previous.get(message.id);
            previous.delete(message.id);
            const receipts = session.t3AttachmentReceipts;
            if (!existing && message.role === "user" && receipts?.length) {
              const hash = hashPrompt(message.text);
              const index = receipts.findIndex(
                ({ promptHash }) => promptHash === hash,
              );
              if (index !== -1)
                message.attachments = receipts.splice(index, 1)[0]?.attachments;
            } else if (existing?.attachments) {
              message.attachments = existing.attachments;
            }
            if (
              existing?.text !== message.text ||
              existing.status !== message.status
            )
              emit({ type: "message", message });
          }
          for (const message of previous.values()) {
            if (message.status === "streaming")
              emit({
                type: "message",
                message: { ...message, status: "complete" },
              });
          }
          if (session.status !== status) {
            if (status === "waiting")
              emit({
                type: "message",
                message: completeMessage("Answer in T3 Code.", "system"),
              });
            emit({ type: "status", status });
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const message =
          error instanceof HttpError
            ? error.message
            : "Could not read the linked T3 Code thread.";
        if (lastError !== message)
          for (const { emit } of sessions.values())
            emit({ type: "error", message });
        lastError = message;
      } finally {
        polling = false;
        if (!controller.signal.aborted) schedule(startedAt + interval);
      }
    };
    const schedule = (regularAt: number) => {
      const now = performance.now();
      // A slow show can cross a deadline. Skip it instead of starting a burst of reads.
      earlyReads = earlyReads.filter((deadline) => deadline >= now);
      const next = earlyReads.shift() ?? regularAt;
      timer = setTimeout(poll, Math.max(0, next - now));
    };
    this.watches.set(id, {
      sessions,
      stop: () => {
        controller.abort();
        clearTimeout(timer);
        this.watches.delete(id);
      },
      afterSend: () => {
        const sentAt = performance.now();
        earlyReads = afterSendPollMs.map((delay) => sentAt + delay);
        if (polling) return;
        clearTimeout(timer);
        schedule(sentAt + workingPollMs);
      },
    });
    void poll();
  }

  unwatch(session: AgentSession) {
    if (!session.t3Thread) return;
    const watch = this.watches.get(session.t3Thread.threadId);
    watch?.sessions.delete(session.id);
    if (watch?.sessions.size === 0) watch.stop();
  }

  close() {
    for (const watch of this.watches.values()) watch.stop();
  }

  async send(
    project: Project,
    threadId: string,
    session: LinkedSession,
    turn: AgentTurn,
  ) {
    if (turn.skills.length)
      throw new HttpError(400, "Choose skills in T3 Code for this chat.");
    const attachments = await projectAttachments(project, turn);
    let digest: string | null;
    try {
      const items = await this.review.list(project);
      // Use the same review transitions without opening a local run or claiming notes.
      for (const item of items) {
        if (item.review.status !== "open") continue;
        await this.review
          .act(project, item.id, { type: "send" }, { kind: "human" })
          .catch((error: unknown) => {
            if (
              !(error instanceof HttpError) ||
              ![404, 409].includes(error.status)
            )
              throw error;
          });
      }
      const current = items.some((item) => item.review.status === "open")
        ? await this.review.list(project)
        : items;
      digest = reviewDigest(project, current);
      const seen = new Set(attachments.map(({ path }) => path));
      for (const item of current) {
        if (
          !item.framePath ||
          !unfinishedStatuses.some((status) => status === item.review.status)
        )
          continue;
        const path = await projectPath(
          project,
          relative(project.path, item.framePath),
        ).catch((error: unknown) => {
          if (error instanceof HttpError) return undefined;
          throw error;
        });
        if (!path || seen.has(path)) continue;
        seen.add(path);
        attachments.push({ path, mimeType: "image/png" });
      }
    } catch (error) {
      if (!(error instanceof ReviewFileError)) throw error;
      digest = `Review notes are unavailable: ${error.message} Do not change review status this turn.`;
    }
    // T3 Code owns this session's instructions, so each message names the project itself.
    const origin = `From Cutroom, project ${project.name} at ${project.path}. Use the cutroom_studio MCP tools to inspect and edit it.`;
    const prompt = agentPrompt({
      ...turn,
      attachments,
      context: [origin, digest, turn.context].filter(Boolean).join("\n\n"),
    });
    // The CLI acknowledges delivery without a message ID. Match the mirrored
    // prompt once it appears, which can happen during send or after a queued run starts.
    const receipt = { promptHash: hashPrompt(prompt), attachments };
    const pending = (session.t3AttachmentReceipts ??= []);
    if (attachments.length) pending.push(receipt);
    const result = await this.cli
      .send(threadId, prompt)
      .catch((error: unknown) => {
        const index = pending.indexOf(receipt);
        if (index !== -1) pending.splice(index, 1);
        throw error;
      });
    this.watches.get(threadId)?.afterSend();
    return result;
  }
}
