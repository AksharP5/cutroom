import { expect, test } from "bun:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentSessionSchema } from "../src/shared/agent";
import type { AgentSession } from "../src/shared/agent";
import type { Project } from "../src/shared/project";
import { AGENT_HEADER } from "../src/shared/review";
import { CodexClient } from "../src/server/agents/codex-client";
import { CodexRuntime } from "../src/server/agents/codex";
import { guardClaudeSession } from "../src/server/agents/native-session-conflict";
import {
  codexSessions,
  NativeSessions,
} from "../src/server/agents/native-sessions";
import {
  claudeTranscript,
  codexTranscript,
  codexTurnsSchema,
} from "../src/server/agents/native-transcript";
import { createAgentRoutes } from "../src/server/agents/routes";
import { createAgentService } from "../src/server/agents/service";
import type { RuntimeFactory } from "../src/server/agents/runtime";
import { createProjectStore } from "../src/server/projects/store";
import { createReviewService } from "../src/server/projects/review";

const sourceId = "93b81e58-dd6b-4387-9b6b-4a9f88c71128";
const ownedId = "2fb52a93-f7d2-41e0-8400-f85cb515ba31";
const linkedId = "55bcfe1b-b82c-4337-8971-364134ab4b27";
const forkId = "9b83255d-40c2-4916-8ccb-f63ec943d184";
const updatedAt = "2026-11-17T22:30:00.000Z";

test("native discovery excludes owned and linked chats, pages past them, and isolates a missing provider", async () => {
  const codex = codexSessions((cwd) => ({
    exited: Promise.resolve(),
    dispose() {},
    async call(method, params) {
      if (method === "account/read")
        return { account: {}, requiresOpenaiAuth: true };
      expect(method).toBe("thread/list");
      expect(params).toMatchObject({
        cwd,
        sourceKinds: ["cli", "exec"],
        sortKey: "updated_at",
        limit: 50,
      });
      const metadata = {
        cwd,
        source: "cli",
        createdAt: 1794954600,
        updatedAt: 1794954600,
        preview: "An opening line\nA second line",
      };
      return params?.cursor
        ? { data: [{ ...metadata, id: sourceId }] }
        : {
            data: [
              { ...metadata, id: ownedId },
              { ...metadata, id: linkedId },
            ],
            nextCursor: "more",
          };
    },
  }));
  const nativeSessions = new NativeSessions({
    codex,
    claude: {
      async list() {
        throw Object.assign(new Error("private path"), { code: "ENOENT" });
      },
      async open() {
        throw new Error("unexpected");
      },
    },
  });

  await withService(
    nativeSessions,
    runtimeFactory(async () => {}),
    async (project, service) => {
      const response = await createAgentRoutes(service).request(
        `/projects/${project.id}/native-sessions`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        sessions: [
          {
            provider: "codex",
            id: sourceId,
            title: "An opening line",
            updatedAt,
          },
        ],
        unavailable: [
          { provider: "claude", reason: "Claude Code is not installed." },
        ],
      });
    },
    true,
  );
});

test("imports verbatim text and completed tool rows in order, with the number of older rows omitted", () => {
  const entry = (
    uuid: string,
    type: SessionMessage["type"],
    content: unknown,
  ): SessionMessage => ({
    uuid,
    type,
    session_id: sourceId,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: type, content },
  });
  const old = Array.from({ length: 200 }, (_, index) =>
    entry(`old-${index}`, "user", "old message"),
  );
  const text = "  Keep whitespace.\nNext line.  ";
  const claude = claudeTranscript(
    [
      ...old,
      entry("hidden", "system", "internal instructions"),
      entry("user", "user", text),
      entry("tool", "assistant", [
        {
          type: "tool_use",
          id: "read",
          name: "Read",
          input: { file_path: "/project/index.html" },
        },
      ]),
      entry("result", "user", [
        {
          type: "tool_result",
          tool_use_id: "read",
          content: "permission denied",
          is_error: true,
        },
      ]),
      entry("assistant", "assistant", [
        { type: "text", text: "I can try a different file." },
      ]),
    ],
    "/project",
    updatedAt,
  );
  expect(claude.omittedMessages).toBe(3);
  expect(claude.messages).toHaveLength(200);
  expect(claude.messages.slice(-3)).toMatchObject([
    { role: "user", text },
    {
      role: "tool",
      text: "permission denied",
      tool: "Read",
      target: "index.html",
      status: "failed",
    },
    { role: "assistant", text: "I can try a different file." },
  ]);

  const codex = codexTranscript(
    codexTurnsSchema.parse([
      {
        items: [
          {
            id: "user",
            type: "userMessage",
            content: [{ type: "text", text }],
          },
          { id: "hook", type: "hookPrompt", text: "internal instructions" },
          {
            id: "command",
            type: "commandExecution",
            command: "/bin/bash -lc 'pwd'",
            aggregatedOutput: "/project",
            status: "completed",
          },
          {
            id: "assistant",
            type: "agentMessage",
            text: "I'm in the project.",
          },
        ],
      },
    ]),
    "/project",
    updatedAt,
  );
  expect(codex.omittedMessages).toBe(0);
  expect(codex.messages).toMatchObject([
    { role: "user", text },
    {
      role: "tool",
      text: "/bin/bash -lc 'pwd'\n/project",
      tool: "Shell",
      target: "pwd",
      status: "complete",
    },
    { role: "assistant", text: "I'm in the project." },
  ]);
});

test("Claude blocks only a recent outside write", () => {
  const now = Date.parse(updatedAt);
  const recent = now - 30_000;
  expect(() => guardClaudeSession(recent, recent, now)).not.toThrow();
  expect(() => guardClaudeSession(recent, recent - 1, now)).toThrow(
    "less than two minutes ago",
  );
  expect(() => guardClaudeSession(now - 180_000, undefined, now)).not.toThrow();
});

test.each(["codex", "claude"] as const)(
  "%s Continue and Branch use the correct runtime IDs, and only Claude checks its last write",
  async (provider) => {
    const runs: Array<string | undefined> = [];
    let modified = Date.now() - 180_000;
    const nativeSessions = fixtures(() => Promise.resolve(modified));
    const factory = runtimeFactory(async (id) => {
      runs.push(id);
      modified = Date.now();
    });
    await withService(nativeSessions, factory, async (project, service) => {
      const routes = createAgentRoutes(service);
      const path = `/projects/${project.id}/native-sessions`;
      const payload = { provider, sessionId: sourceId };
      expect(
        (
          await post(routes, `${path}/continue`, {
            ...payload,
            sessionId: "../scratch",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(routes, `${path}/branch`, payload, {
            [AGENT_HEADER]: "agent",
          })
        ).status,
      ).toBe(409);
      const [first, second] = await Promise.all([
        post(routes, `${path}/continue`, payload),
        post(routes, `${path}/continue`, payload),
      ]);
      const continued = await sessionResponse(first);
      expect((await sessionResponse(second)).id).toBe(continued.id);

      const branch = await sessionResponse(
        await post(routes, `${path}/branch`, payload),
      );
      expect(branch.nativeSessionId).toBe(forkId);
      expect(continued.nativeImport).toEqual({
        mode: "continue",
        omittedMessages: 3,
      });
      expect(branch.nativeImport).toEqual({
        mode: "branch",
        omittedMessages: 3,
      });

      const turns = `/agents/sessions/${continued.id}/turns`;
      const send = () =>
        post(routes, turns, { text: "Do you recall the code?" });
      expect((await send()).status).toBe(202);
      await idle(service, continued.id);
      if (provider === "claude") {
        expect(service.get(continued.id).nativeImport?.lastOwnWrite).toBe(
          modified,
        );
        expect((await send()).status).toBe(202);
        await idle(service, continued.id);
        modified++;
        const busy = await send();
        expect(busy.status).toBe(409);
        expect(await busy.json()).toEqual({
          code: "native_session_conflict",
          error:
            "This chat changed in another app less than two minutes ago. Wait, or branch it.",
        });
      }
      const branched = await post(
        routes,
        `/agents/sessions/${branch.id}/turns`,
        { text: "Do you recall the code?" },
      );
      expect(branched.status).toBe(202);
      await idle(service, branch.id);
      expect(runs).toEqual(
        provider === "claude"
          ? [sourceId, sourceId, forkId]
          : [sourceId, forkId],
      );
    });
  },
);

test("a Codex writer refusal is a 409 before Cutroom adds the outgoing message", async () => {
  let nativeClient: CodexClient | undefined;
  const nativeSessions = fixtures(async () => {
    throw new Error("unexpected");
  });
  const script = `
    import { createInterface } from "node:readline";
    for await (const line of createInterface({ input: process.stdin })) {
      const { id, method } = JSON.parse(line);
      if (id === undefined) continue;
      const result = method === "initialize" ? {} : { config: {} };
      const error = { code: -32603, message: "thread ${sourceId} already has an active writer" };
      console.log(JSON.stringify(method === "thread/resume" ? { id, error } : { id, result }));
    }
  `;
  const factory: RuntimeFactory = {
    ...runtimeFactory(async () => {}),
    create(_provider, options) {
      nativeClient ??= new CodexClient({
        executable: process.execPath,
        args: ["-e", script],
      });
      return new CodexRuntime(nativeClient, options);
    },
    dispose() {
      nativeClient?.dispose();
    },
  };
  await withService(nativeSessions, factory, async (project, service) => {
    const routes = createAgentRoutes(service);
    const session = await sessionResponse(
      await post(routes, `/projects/${project.id}/native-sessions/continue`, {
        provider: "codex",
        sessionId: sourceId,
      }),
    );
    const response = await post(
      routes,
      `/agents/sessions/${session.id}/turns`,
      { text: "Can you recall the code?" },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This chat is open in another app. Close it there, or branch it.",
      code: "native_session_conflict",
    });
    expect(service.get(session.id).messages).toEqual(session.messages);
  });
  await nativeClient?.exited;
});

function post(
  routes: ReturnType<typeof createAgentRoutes>,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  return routes.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function sessionResponse(response: Response) {
  expect(response.status).toBe(201);
  return agentSessionSchema.parse(await response.json());
}

function idle(
  service: Awaited<ReturnType<typeof createAgentService>>,
  id: string,
) {
  if (service.get(id).status === "idle") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("The agent did not return to idle."));
    }, 2_000);
    const unsubscribe = service.subscribe(id, ({ event }) => {
      if (event.type !== "status" || event.status !== "idle") return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

function runtimeFactory(send: (id?: string) => Promise<void>): RuntimeFactory {
  return {
    capabilities: async (provider) => ({
      provider,
      available: true,
      models: [],
      skills: [],
      mcpServers: [],
    }),
    create(provider, { nativeSessionId }) {
      return {
        send: () => send(nativeSessionId),
        ...(provider === "claude" && { closeAfterTurn: async () => true }),
        interrupt: async () => {},
        dispose() {},
      };
    },
    dispose() {},
  };
}

function fixtures(changedAt: () => Promise<number>) {
  const adapter = {
    list: async () => [],
    async open(_cwd: string, id: string, mode: "continue" | "branch") {
      expect(id).toBe(sourceId);
      return {
        id: mode === "continue" ? sourceId : forkId,
        title: "Synthetic terminal chat",
        updatedAt,
        omittedMessages: 3,
        messages: [],
      };
    },
  };
  return new NativeSessions({ claude: adapter, codex: adapter }, changedAt);
}

async function withService(
  nativeSessions: NativeSessions,
  factory: RuntimeFactory,
  run: (
    project: Project,
    service: Awaited<ReturnType<typeof createAgentService>>,
  ) => Promise<void>,
  seed = false,
) {
  const scratch = join(homedir(), ".cache", "cutroom-continue-run");
  await mkdir(scratch, { recursive: true });
  const dataDir = await mkdtemp(join(scratch, "unit-"));
  const projects = await createProjectStore({ dataDir });
  try {
    const project = await projects.create({ name: "Synthetic project" });
    if (seed) {
      const legacy: AgentSession = {
        id: "legacy",
        projectId: project.id,
        provider: "codex",
        title: "Legacy conversation",
        nativeSessionId: ownedId,
        createdAt: updatedAt,
        updatedAt,
        status: "idle",
        messages: [],
      };
      await writeFile(
        join(dataDir, "agents.json"),
        JSON.stringify({
          version: 1,
          sessions: [
            legacy,
            {
              ...legacy,
              id: "linked",
              nativeSessionId: undefined,
              t3Thread: { threadId: linkedId },
            },
          ],
        }),
      );
    }
    const service = await createAgentService({
      projects,
      review: createReviewService(projects),
      dataDir,
      nativeSessions,
      runtimeFactory: factory,
    });
    try {
      await run(project, service);
    } finally {
      await service.dispose();
    }
  } finally {
    projects.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
