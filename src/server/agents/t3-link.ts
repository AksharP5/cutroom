import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { t3ThreadIdSchema } from "../../shared/agent";
import type { AgentMessage, AgentStatus } from "../../shared/agent";
import { HttpError } from "../../shared/errors";

const threadSchema = z.object({
  threadId: t3ThreadIdSchema,
  title: z.string(),
  status: z.string(),
  providerInstanceId: z.string(),
  model: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const listSchema = z.array(threadSchema);
const showSchema = z.object({
  thread: threadSchema.extend({
    pendingRequestCount: z.number(),
    activeRunId: z.string().nullable(),
    latestRunId: z.string().nullable(),
    archived: z.boolean(),
  }),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "tool", "system"]),
      runId: z.string().nullable(),
      text: z.string(),
    }),
  ),
});
const sendSchema = z.object({
  threadId: t3ThreadIdSchema,
  delivery: z.enum(["started", "queued"]),
});

export type T3Thread = z.infer<typeof threadSchema>;

export function threadStatus(
  thread: z.infer<typeof showSchema>["thread"],
): AgentStatus {
  if (thread.pendingRequestCount > 0 || thread.status === "waiting")
    return "waiting";
  if (
    thread.activeRunId ||
    ["starting", "running", "queued"].includes(thread.status)
  )
    return "running";
  if (["failed", "error"].includes(thread.status)) return "error";
  return "idle";
}

export function threadMessages(
  { thread, messages }: z.infer<typeof showSchema>,
  history: AgentMessage[] = [],
): AgentMessage[] {
  const window = messages.map(({ role, runId, text }) => ({
    prefix: `t3:${JSON.stringify([runId, role])}:`,
    role,
    runId,
    text,
  }));
  const mirrored = history.filter(({ id }) => id.startsWith("t3:"));
  // Show returns a tail window without message IDs. Match its head to the
  // saved tail before allocating IDs, even if the window starts mid-run.
  let overlap = Math.min(mirrored.length, window.length);
  while (
    overlap > 0 &&
    !mirrored.slice(-overlap).every((previous, index) => {
      const next = window[index];
      return (
        next &&
        previous.id.startsWith(next.prefix) &&
        (previous.text === next.text ||
          (previous.status === "streaming" &&
            next.text.startsWith(previous.text)))
      );
    })
  )
    overlap--;
  const ids = new Set(mirrored.map(({ id }) => id));
  const ordinals = new Map<string, number>();
  return window.map(({ prefix, role, runId, text }, index) => {
    const previous = index < overlap ? mirrored.at(index - overlap) : undefined;
    let ordinal = ordinals.get(prefix) ?? 0;
    if (!previous) {
      while (ids.has(`${prefix}${ordinal}`)) ordinal++;
      ordinals.set(prefix, ordinal + 1);
    }
    return {
      id: previous?.id ?? `${prefix}${ordinal}`,
      role,
      text,
      createdAt: thread.createdAt,
      status:
        role === "assistant" && runId !== null && runId === thread.activeRunId
          ? "streaming"
          : "complete",
    };
  });
}

export type T3Runner = (
  args: string[],
  input?: string,
  signal?: AbortSignal,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const runT3: T3Runner = async (args, input, signal) => {
  const executable =
    process.env.T3CODE_CLI_PATH ||
    Bun.which("t3") ||
    Bun.which(join(homedir(), ".t3/bin/t3"));
  if (!executable)
    throw new HttpError(503, "The T3 Code CLI is not installed.");
  try {
    const process = Bun.spawn([executable, ...args], {
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
        : AbortSignal.timeout(8_000),
    });
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } catch {
    throw new HttpError(
      503,
      "Could not run the T3 Code CLI. Check that it is installed and T3 Code is open.",
    );
  }
};

export class T3Link {
  private readonly showing = new Map<string, Promise<unknown>>();

  constructor(private readonly run: T3Runner = runT3) {}

  private async call<T>(
    schema: z.ZodType<T>,
    args: string[],
    options?: { input?: string; signal?: AbortSignal },
  ) {
    const baseDir = process.env.T3CODE_HOME;
    const { code, stdout, stderr } = await this.run(
      [
        "thread",
        ...args,
        "--json",
        "--log-level",
        "none",
        ...(baseDir ? ["--base-dir", baseDir] : []),
      ],
      options?.input,
      options?.signal,
    );
    if (code !== 0) {
      // CLI output can include thread content. Use it only to identify known errors.
      const output = `${stderr}\n${stdout}`;
      if (output.includes("No T3 Code project matches"))
        throw new HttpError(404, "This folder is not registered in T3 Code.");
      if (output.includes("is no longer available"))
        throw new HttpError(404, "This T3 Code thread is no longer available.");
      if (output.includes("No running T3 Code server"))
        throw new HttpError(503, "Start T3 Code, then try again.");
      throw new HttpError(
        503,
        "T3 Code did not complete the command. Check the thread in T3 Code.",
      );
    }
    try {
      return schema.parse(JSON.parse(stdout));
    } catch {
      throw new HttpError(
        503,
        "The T3 Code CLI returned an unreadable response.",
      );
    }
  }

  async list(folder: string): Promise<T3Thread[]> {
    try {
      return await this.call(listSchema, ["list", "--project", folder]);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return [];
      throw error;
    }
  }

  async show(id: string, signal?: AbortSignal) {
    const previous = this.showing.get(id);
    const show = async () => {
      if (previous) await previous.catch(() => {});
      signal?.throwIfAborted();
      const value = await this.call(
        showSchema,
        ["show", "--messages", "40", id],
        { signal },
      );
      if (value.thread.threadId !== id || value.thread.archived)
        throw new HttpError(404, "This T3 Code thread is no longer available.");
      return value;
    };
    const pending = show();
    this.showing.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.showing.get(id) === pending) this.showing.delete(id);
    }
  }

  async send(id: string, text: string) {
    const ack = await this.call(sendSchema, ["send", id, "-"], { input: text });
    return { queued: ack.delivery === "queued" };
  }
}
