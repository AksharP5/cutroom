import { version } from "../../shared/version";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

const rpcMessageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string() })
    .passthrough()
    .optional(),
});
export type RpcMessage = z.infer<typeof rpcMessageSchema>;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export type CodexProcessOptions = {
  executable?: string;
  args?: string[];
  cwd?: string;
};

export class CodexClient {
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private sequence = 0;
  private closed = false;
  private stderr = "";
  version?: string;
  private readonly process;
  readonly ready: Promise<void>;

  constructor(options: CodexProcessOptions = {}) {
    this.process = spawn(
      options.executable ?? "codex",
      options.args ?? ["app-server", "--listen", "stdio://"],
      {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8_000);
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        this.fail(new Error("Codex returned an invalid protocol message."));
        return;
      }
      const result = rpcMessageSchema.safeParse(data);
      if (!result.success) {
        this.fail(new Error("Codex returned an unsupported protocol message."));
        return;
      }
      const message = result.data;
      if (message.method) {
        for (const listener of this.listeners) listener(message);
        return;
      }
      if (typeof message.id !== "number") return;
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", (code, signal) => {
      lines.close();
      this.fail(
        new Error(
          `Codex process exited${signal ? ` (${signal})` : ` (${code})`}.${this.stderr ? ` ${this.stderr.trim()}` : ""}`,
        ),
      );
    });
    this.ready = this.request("initialize", {
      clientInfo: { name: "cutroom", title: "Cutroom", version },
    })
      .then((value) => {
        const metadata = z
          .object({ userAgent: z.string().optional() })
          .parse(value);
        this.version = metadata.userAgent?.match(/\/(\d+\.\d+\.\d+)/)?.[1];
        this.notify("initialized", {});
      })
      .catch((error) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        throw error;
      });
  }

  get connected() {
    return !this.closed;
  }

  subscribe(listener: (message: RpcMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    await this.ready;
    return this.request(method, params);
  }

  respond(id: string | number, result: unknown) {
    this.write({ id, result });
  }
  reject(id: string | number, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }
  notify(method: string, params: Record<string, unknown>) {
    this.write({ method, params });
  }

  private request(method: string, params: Record<string, unknown>) {
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not answer ${method} within 60 seconds.`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private write(message: Record<string, unknown>) {
    if (this.closed || !this.process.stdin.writable)
      throw new Error("The Codex connection is closed.");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners)
      listener({
        method: "cutroom/disconnected",
        params: { message: error.message },
      });
    this.listeners.clear();
    this.process.kill();
  }

  dispose() {
    this.fail(new Error("The Codex connection was closed."));
  }
}
