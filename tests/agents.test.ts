import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentEvent,
  AgentRequest,
  AgentStatus,
} from "../src/shared/agent";
import { z } from "zod";
import {
  agentEventEnvelopeSchema,
  agentSessionSummarySchema,
  toolTarget,
} from "../src/shared/agent";
import { codexToolPermissions } from "../src/server/agents/tool-permissions";
import { CodexClient } from "../src/server/agents/codex-client";
import { CodexRuntime } from "../src/server/agents/codex";
import { createAgentRoutes } from "../src/server/agents/routes";
import { createAgentService } from "../src/server/agents/service";
import type { AgentService } from "../src/server/agents/service";
import type {
  RuntimeFactory,
  RuntimeOptions,
} from "../src/server/agents/runtime";
import { toolCalls } from "../src/server/agents/runtime";
import { createProjectStore } from "../src/server/projects/store";
import { createReviewService } from "../src/server/projects/review";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function setup(runtimeFactory: RuntimeFactory) {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-agents-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const projects = await createProjectStore({
    dataDir: join(directory, "state"),
  });
  cleanup.push(() => projects.close());
  const project = await projects.create({ name: "Agent editing" });
  const dataDir = join(directory, "chat");
  const service = await createAgentService({
    projects,
    review: createReviewService(projects),
    dataDir,
    runtimeFactory,
  });
  cleanup.push(() => service.dispose());
  return { directory, projects, project, service, dataDir };
}

function idle(service: AgentService, id: string, target: AgentStatus = "idle") {
  if (service.get(id).status === target) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Agent never reached ${target}`));
    }, 2_000);
    const unsubscribe = service.subscribe(id, ({ event }) => {
      if (
        (event.type === "status" && event.status === target) ||
        (event.type === "request" && target === "waiting")
      ) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

function factory(
  run: (options: RuntimeOptions) => Promise<void>,
): RuntimeFactory {
  return {
    capabilities: async (provider) => ({
      provider,
      available: true,
      skills: [],
      models: [],
      mcpServers: [],
    }),
    create: (_provider, options) => ({
      send: () => run(options),
      interrupt: async () => {},
      dispose: () => {},
    }),
    dispose: () => {},
  };
}

describe("agent conversations", () => {
  test("streams a native reply, persists it, and resumes the recorded native session", async () => {
    const observed: AgentEvent[] = [];
    const runtime = factory(async (options) => {
      options.emit({ type: "native-session", nativeSessionId: "native-42" });
      options.emit({
        type: "message",
        message: {
          id: "reply",
          role: "assistant",
          text: "",
          createdAt: new Date().toISOString(),
          status: "streaming",
        },
      });
      options.emit({ type: "delta", messageId: "reply", text: "Ready to " });
      options.emit({ type: "delta", messageId: "reply", text: "edit." });
    });
    const { service, project, projects, dataDir } = await setup(runtime);
    const session = await service.create({
      projectId: project.id,
      provider: "codex",
    });
    const unsubscribe = service.subscribe(session.id, (envelope) => {
      agentEventEnvelopeSchema.parse(envelope);
      observed.push(envelope.event);
    });
    cleanup.push(unsubscribe);
    await service.send(session.id, {
      text: "Prepare the edit",
      skills: [],
      attachments: [],
    });
    await idle(service, session.id);
    const reply = service.get(session.id);
    expect(reply.nativeSessionId).toBe("native-42");
    expect(reply.messages.find((message) => message.id === "reply")?.text).toBe(
      "Ready to edit.",
    );
    expect(
      reply.messages.find((message) => message.id === "reply")?.status,
    ).toBe("complete");
    expect(observed[0]?.type).toBe("snapshot");
    expect(observed.filter((event) => event.type === "delta")).toHaveLength(2);
    await service.dispose();
    let resumed: string | undefined;
    let resumedModel: string | undefined;
    const restored = await createAgentService({
      projects,
      review: createReviewService(projects),
      dataDir,
      runtimeFactory: factory(async (options) => {
        resumed = options.nativeSessionId;
        resumedModel = options.model;
      }),
    });
    cleanup.push(() => restored.dispose());
    expect(restored.get(session.id).messages).toHaveLength(2);
    const updated = await restored.configure(session.id, {
      model: "chosen-model",
    });
    expect(updated.nativeSessionId).toBe("native-42");
    expect(updated.messages).toHaveLength(2);
    await restored.send(session.id, {
      text: "Continue",
      skills: [],
      attachments: [],
    });
    await idle(restored, session.id);
    expect(resumed).toBe("native-42");
    expect(resumedModel).toBe("chosen-model");
  });

  test("a tool call names its project file from start through result and reload", async () => {
    const { service, project, projects, dataDir } = await setup(
      factory(async (options) => {
        // Claude Code reports absolute paths; the row should say what a person would.
        const tools = toolCalls(options.cwd);
        options.emit({
          type: "message",
          message: tools.start("edit-1", "Edit", {
            file_path: join(options.cwd, "index.html"),
            old_string: "a",
            new_string: "b",
          }),
        });
        options.emit({
          type: "message",
          message: tools.finish("edit-1", "The file was updated.", false),
        });
      }),
    );
    const session = await service.create({
      projectId: project.id,
      provider: "claude",
    });
    await service.send(session.id, {
      text: "Edit the title",
      skills: [],
      attachments: [],
    });
    await idle(service, session.id);
    const expected = {
      id: "edit-1",
      role: "tool",
      tool: "Edit",
      target: "index.html",
      text: "The file was updated.",
      status: "complete",
    };
    expect(service.get(session.id).messages).toContainEqual(
      expect.objectContaining(expected),
    );
    await service.dispose();
    const restored = await createAgentService({
      projects,
      review: createReviewService(projects),
      dataDir,
      runtimeFactory: factory(async () => {}),
    });
    cleanup.push(() => restored.dispose());
    expect(restored.get(session.id).messages).toContainEqual(
      expect.objectContaining(expected),
    );
  });

  test("waits for an approval and refuses stale answers", async () => {
    const { service, project } = await setup(
      factory(async (options) => {
        const response = await options.request({
          id: "permission-1",
          kind: "approval",
          title: "Edit this source?",
          tool: "Write",
          input: { file: "index.html" },
        });
        options.emit({
          type: "message",
          message: {
            id: "decision",
            role: "assistant",
            text:
              response.decision === "allow" ? "Edit approved" : "Edit declined",
            createdAt: new Date().toISOString(),
            status: "complete",
          },
        });
      }),
    );
    const session = await service.create({
      projectId: project.id,
      provider: "claude",
    });
    await service.send(session.id, {
      text: "Change the title",
      skills: [],
      attachments: [],
    });
    await idle(service, session.id, "waiting");
    expect(service.get(session.id).pendingRequest?.title).toBe(
      "Edit this source?",
    );
    await expect(
      service.configure(session.id, { model: "other" }),
    ).rejects.toThrow("Stop the current run");
    await expect(
      service.respond(session.id, { requestId: "old", decision: "allow" }),
    ).rejects.toThrow("already been answered");
    await service.respond(session.id, {
      requestId: "permission-1",
      decision: "deny",
    });
    await idle(service, session.id);
    expect(service.get(session.id).messages.at(-1)?.text).toBe("Edit declined");
    expect(service.get(session.id).pendingRequest).toBeUndefined();
  });

  test("admits only one turn while native skill validation is pending", async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const native = factory(async () => {});
    native.capabilities = async (provider) => {
      await waiting;
      return {
        provider,
        available: true,
        skills: [
          {
            name: "editing",
            path: "/native/editing/SKILL.md",
            description: "Editing",
            enabled: true,
          },
        ],
        models: [],
        mcpServers: [],
      };
    };
    const { service, project } = await setup(native);
    const session = await service.create({
      projectId: project.id,
      provider: "codex",
    });
    const first = service.send(session.id, {
      text: "Use editing",
      skills: [{ name: "editing" }],
      attachments: [],
    });
    const second = service.send(session.id, {
      text: "Do not duplicate",
      skills: [],
      attachments: [],
    });
    await expect(second).rejects.toThrow("This agent is working");
    release?.();
    await first;
    await idle(service, session.id);
    expect(
      service
        .get(session.id)
        .messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  test("stopping a turn during skill discovery prevents it from starting", async () => {
    let release: (() => void) | undefined;
    let discovered: (() => void) | undefined;
    const discovery = new Promise<void>((resolve) => {
      discovered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish: (() => void) | undefined;
    const replacement = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let starts = 0;
    const native = factory(async () => {
      starts++;
      await replacement;
    });
    native.capabilities = async (provider) => {
      discovered?.();
      await waiting;
      return {
        provider,
        available: true,
        skills: [
          {
            name: "editing",
            path: "/native/editing/SKILL.md",
            description: "Editing",
            enabled: true,
          },
        ],
        models: [],
        mcpServers: [],
      };
    };
    const { service, project } = await setup(native);
    const session = await service.create({
      projectId: project.id,
      provider: "codex",
    });
    const pending = service.send(session.id, {
      text: "Use editing",
      skills: [{ name: "editing" }],
      attachments: [],
    });
    await discovery;
    try {
      await service.interrupt(session.id);
      expect(
        await Promise.race([
          pending.then(() => true),
          Bun.sleep(200).then(() => false),
        ]),
      ).toBe(true);
      expect(starts).toBe(0);
      expect(service.get(session.id).messages).toHaveLength(0);
      await service.send(session.id, {
        text: "A replacement request",
        skills: [],
        attachments: [],
      });
      expect(service.get(session.id).status).toBe("running");
      release?.();
      await waiting;
      expect(service.get(session.id).status).toBe("running");
      expect(starts).toBe(1);
      finish?.();
      await idle(service, session.id);
    } finally {
      release?.();
      finish?.();
      await pending;
    }
  });

  test("shutdown cancels admission instead of starting a native process afterward", async () => {
    let release: (() => void) | undefined;
    let discovered: (() => void) | undefined;
    const discovery = new Promise<void>((resolve) => {
      discovered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let starts = 0;
    const native = factory(async () => {
      starts++;
    });
    native.capabilities = async (provider) => {
      discovered?.();
      await waiting;
      return {
        provider,
        available: true,
        skills: [
          {
            name: "editing",
            path: "/native/editing/SKILL.md",
            description: "Editing",
            enabled: true,
          },
        ],
        models: [],
        mcpServers: [],
      };
    };
    const { service, project } = await setup(native);
    const session = await service.create({
      projectId: project.id,
      provider: "codex",
    });
    const pending = service.send(session.id, {
      text: "Use editing",
      skills: [{ name: "editing" }],
      attachments: [],
    });
    await discovery;
    await service.dispose();
    release?.();
    await pending;
    expect(starts).toBe(0);
    await expect(
      service.send(session.id, {
        text: "After shutdown",
        skills: [],
        attachments: [],
      }),
    ).rejects.toThrow("closed");
  });

  test("disposed native runtimes cannot change or interrupt the next conversation turn", async () => {
    const connections: RuntimeOptions[] = [];
    let complete: (() => void) | undefined;
    let stops = 0;
    const native = factory(async () => {});
    native.create = (_provider, options) => {
      connections.push(options);
      return {
        send: () =>
          connections.length === 1
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                complete = resolve;
              }),
        interrupt: async () => {},
        dispose: () => {
          stops++;
          options.emit({ type: "error", message: "Old connection closed" });
        },
      };
    };
    const { service, project } = await setup(native);
    const session = await service.create({
      projectId: project.id,
      provider: "codex",
    });
    await service.send(session.id, {
      text: "First turn",
      skills: [],
      attachments: [],
    });
    await idle(service, session.id);
    await service.configure(session.id, { model: "another-model" });
    await service.send(session.id, {
      text: "Second turn",
      skills: [],
      attachments: [],
    });
    connections[0]?.emit({ type: "error", message: "Late old error" });
    const oldQuestion = connections[0]?.request({
      id: "old-request",
      kind: "approval",
      title: "Old permission",
      tool: "Write",
      input: {},
    });
    expect(service.get(session.id).status).toBe("running");
    expect(service.get(session.id).pendingRequest).toBeUndefined();
    expect((await oldQuestion)?.decision).toBe("deny");
    expect(
      service.get(session.id).messages.map((message) => message.text),
    ).toEqual(["First turn", "Second turn"]);
    expect(stops).toBe(1);
    complete?.();
    await idle(service, session.id);
  });

  test("an approval save failure denies the native request instead of stranding it", async () => {
    let decision: string | undefined;
    const { service, project, dataDir } = await setup(
      factory(async (options) => {
        const answer = await options.request({
          id: "permission",
          kind: "approval",
          title: "Write source?",
          tool: "Write",
          input: {},
        });
        decision = answer.decision;
      }),
    );
    const session = await service.create({
      projectId: project.id,
      provider: "claude",
    });
    await service.send(session.id, {
      text: "Edit the source",
      skills: [],
      attachments: [],
    });
    await idle(service, session.id, "waiting");
    const backup = `${dataDir}.saved`;
    await rename(dataDir, backup);
    await writeFile(dataDir, "Blocks the history directory");
    try {
      await expect(
        service.respond(session.id, {
          requestId: "permission",
          decision: "allow",
        }),
      ).rejects.toThrow();
      // The turn ends idle, then its own history save fails too, so the
      // session settles in error. Waiting for idle races that second failure.
      await idle(service, session.id, "error");
      expect(decision).toBe("deny");
      expect(service.get(session.id).pendingRequest).toBeUndefined();
    } finally {
      await rm(dataDir);
      await rename(backup, dataDir);
    }
  });

  test("validates routes and project attachment boundaries", async () => {
    const { service, project, directory } = await setup(
      factory(async () => {}),
    );
    const routes = createAgentRoutes(service);
    const invalid = await routes.request("/agents/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, provider: "made-up" }),
    });
    expect(invalid.status).toBe(400);
    const session = await service.create({
      projectId: project.id,
      provider: "codex",
    });
    const outside = join(directory, "outside.txt");
    await writeFile(outside, "not a project attachment");
    await expect(
      service.send(session.id, {
        text: "Read attachment",
        skills: [],
        attachments: [{ path: outside }],
      }),
    ).rejects.toThrow("outside the project");
    await expect(
      service.send(session.id, {
        text: "Use a skill",
        skills: [{ name: "not-installed", path: "/outside/SKILL.md" }],
        attachments: [],
      }),
    ).rejects.toThrow("unavailable");
    expect(service.get(session.id).messages).toHaveLength(0);
    const listResponse = await routes.request(
      `/agents/sessions?projectId=${project.id}`,
    );
    const list = z
      .object({ sessions: z.array(agentSessionSummarySchema) })
      .parse(await listResponse.json());
    expect(list.sessions[0]?.id).toBe(session.id);
    expect(Object.keys(list.sessions[0] ?? {})).not.toContain("messages");
  });
});

const nativeFixture = String.raw`
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const reply = value => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of createInterface({input:process.stdin})) {
  const input = JSON.parse(line);
  if (input.method === "initialize") reply({id:input.id,result:{}});
  if (input.method === "config/read") reply({id:input.id,result:{config:{}}});
  if (input.method === "thread/start" || input.method === "thread/resume") { appendFileSync(process.argv[2] + ".thread", JSON.stringify(input.params)); reply({id:input.id,result:{thread:{id:"native-session"}}}); }
  if (input.method === "turn/start") {
    appendFileSync(process.argv[2],JSON.stringify(input.params)+"\n");
    reply({id:input.id,result:{turn:{id:"native-turn"}}});
    if (input.params.input[0].text.includes("Command check")) {
      const item={id:"shell-output",type:"commandExecution",command:"printf checked",cwd:process.cwd(),commandActions:[],status:"inProgress",aggregatedOutput:null,exitCode:null,durationMs:null,processId:null};
      reply({method:"item/started",params:{threadId:"native-session",turnId:"native-turn",item}});
      reply({method:"item/commandExecution/outputDelta",params:{threadId:"native-session",turnId:"native-turn",itemId:item.id,delta:"first "}});
      reply({method:"item/commandExecution/outputDelta",params:{threadId:"native-session",turnId:"native-turn",itemId:item.id,delta:"second"}});
      reply({method:"item/completed",params:{threadId:"native-session",turnId:"native-turn",item:{...item,status:"completed",aggregatedOutput:"first second",exitCode:0,durationMs:12}}});
      reply({method:"turn/completed",params:{threadId:"native-session",turn:{id:"native-turn",status:"completed",error:null}}});
      continue;
    }
    if (input.params.input[0].text.includes("Question check")) {
      reply({id:"question",method:"item/tool/requestUserInput",params:{threadId:"native-session",questions:[{id:"formats",header:"Formats",question:"Output formats?",multiSelect:true,options:input.params.input[0].text.includes("free")?null:[{label:"MP4"},{label:"MOV"}]}]}});
    } else {
      reply({method:"item/started",params:{threadId:"native-session",item:{id:"answer",type:"agentMessage",text:""}}});
      reply({id:"approve",method:"item/commandExecution/requestApproval",params:{threadId:"native-session",command:"touch title.txt",reason:"Edit project"}});
    }
  }
  if (input.id === "approve") {
    reply({method:"item/agentMessage/delta",params:{threadId:"native-session",itemId:"answer",delta:input.result.decision === "accept"?"Approved.":"Declined."}});
    reply({method:"item/completed",params:{threadId:"native-session",item:{id:"answer",type:"agentMessage",text:input.result.decision === "accept"?"Approved.":"Declined."}}});
    reply({method:"turn/completed",params:{threadId:"native-session",turn:{id:"native-turn",status:"completed"}}});
  }
  if (input.id === "question") {
    appendFileSync(process.argv[2]+".answers",JSON.stringify(input.result));
    reply({method:"turn/completed",params:{threadId:"native-session",turn:{id:"native-turn",status:"completed"}}});
  }
  if (input.method === "fail") reply({id:input.id,error:{code:-32000,message:"Exact native failure"}});
}
`;

test("Codex protocol preserves explicit skill inputs, approvals, and native errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-protocol-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "provider.mjs");
  const recording = join(directory, "turns.jsonl");
  await writeFile(script, nativeFixture);
  const client = new CodexClient({
    executable: process.execPath,
    args: [script, recording],
  });
  cleanup.push(() => client.dispose());
  const events: AgentEvent[] = [];
  const requests: AgentRequest[] = [];
  const runtime = new CodexRuntime(
    client,
    {
      cwd: directory,
      agentToken: "test-token",
      emit: (event) => events.push(event),
      request: async (request) => {
        requests.push(request);
        return request.kind === "question"
          ? {
              requestId: request.id,
              decision: "allow",
              answers: { formats: ["MP4", "MOV"] },
            }
          : { requestId: request.id, decision: "deny" };
      },
    },
    { "mcp_servers.cutroom_studio.env.CUTROOM_AGENT_TOKEN": "test-token" },
  );
  cleanup.push(() => runtime.dispose());
  await runtime.send({
    text: "$editing Refine this scene",
    skills: [{ name: "editing", path: "/native/skills/editing/SKILL.md" }],
    attachments: [],
  });
  expect(events.find((event) => event.type === "native-session")).toEqual({
    type: "native-session",
    nativeSessionId: "native-session",
  });
  expect(events.find((event) => event.type === "delta")).toEqual({
    type: "delta",
    messageId: "answer",
    text: "Declined.",
  });
  // Codex applies a thread's config overrides to the MCP servers it starts for that thread.
  expect(
    JSON.parse(await readFile(`${recording}.thread`, "utf8")).config,
  ).toEqual({
    ...codexToolPermissions(),
    "mcp_servers.cutroom_studio.env.CUTROOM_AGENT_TOKEN": "test-token",
  });
  const sent = JSON.parse((await readFile(recording, "utf8")).trim());
  expect(sent.input).toContainEqual({
    type: "skill",
    name: "editing",
    path: "/native/skills/editing/SKILL.md",
  });
  await runtime.send({ text: "Question check", skills: [], attachments: [] });
  expect(JSON.parse(await readFile(`${recording}.answers`, "utf8"))).toEqual({
    answers: { formats: { answers: ["MP4", "MOV"] } },
  });
  await runtime.send({
    text: "Question check free",
    skills: [],
    attachments: [],
  });
  expect(requests.at(-1)).toMatchObject({
    kind: "question",
    questions: [{ id: "formats", question: "Output formats?", options: [] }],
  });
  await expect(client.call("fail")).rejects.toThrow("Exact native failure");
});

test("Codex accepts nullable running command output and streams it before completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-command-protocol-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "provider.mjs");
  await writeFile(script, nativeFixture);
  const client = new CodexClient({
    executable: process.execPath,
    args: [script, join(directory, "turns.jsonl")],
  });
  cleanup.push(() => client.dispose());
  const events: AgentEvent[] = [];
  const runtime = new CodexRuntime(client, {
    cwd: directory,
    agentToken: "test-token",
    emit: (event) => events.push(event),
    request: async (request) => ({ requestId: request.id, decision: "deny" }),
  });
  cleanup.push(() => runtime.dispose());
  await runtime.send({ text: "Command check", skills: [], attachments: [] });
  expect(events.filter((event) => event.type === "delta")).toEqual([
    { type: "delta", messageId: "shell-output", text: "first " },
    { type: "delta", messageId: "shell-output", text: "second" },
  ]);
  const messages = events
    .filter((event) => event.type === "message")
    .map((event) => event.message);
  expect(messages[0]).toMatchObject({
    id: "shell-output",
    role: "tool",
    text: "printf checked\n",
    status: "streaming",
  });
  expect(messages.at(-1)).toMatchObject({
    id: "shell-output",
    role: "tool",
    text: "printf checked\nfirst second",
    status: "complete",
    target: "printf checked",
  });
});

test("tool targets read relative to the project", () => {
  const project = "/home/me/Cutroom/grain-3";
  expect(
    toolTarget({ file_path: `${project}/compositions/intro.html` }, project),
  ).toBe("compositions/intro.html");
  expect(toolTarget({ command: `ls ${project}/assets` }, project)).toBe(
    "ls assets",
  );
  // Paths outside the project stay absolute, so nothing is misattributed.
  expect(toolTarget({ file_path: "/etc/hosts" }, project)).toBe("/etc/hosts");
  expect(toolTarget({ projectId: "abc", frame: 12 }, project)).toBeUndefined();
});

test("Always allow is saved per project, rejects other tools, and revocation cancels a pending run", async () => {
  let allowed = false;
  const runtime = factory(async (options) => {
    await options.request({
      id: "edit",
      kind: "approval",
      tool: "mcp__cutroom_studio__timeline_edit",
      title: "Edit the timeline?",
      input: {},
      canAllowCutroomEdits: true,
    });
    allowed = options.allowCutroomEdits?.() ?? false;
    await options.request({
      id: "shell",
      kind: "approval",
      tool: "Shell",
      title: "Run a command?",
      input: {},
    });
  });
  const { service, projects, project, dataDir } = await setup(runtime);
  const other = await projects.create({ name: "Separate permissions" });
  const session = await service.create({
    projectId: project.id,
    provider: "codex",
  });
  await service.send(session.id, { text: "Edit", skills: [], attachments: [] });
  await idle(service, session.id, "waiting");
  await service.respond(session.id, {
    requestId: "edit",
    decision: "allow",
    alwaysAllowCutroomEdits: true,
  });
  await idle(service, session.id, "waiting");
  expect(allowed).toBe(true);
  expect(await service.permissions(other.id)).toEqual({
    alwaysAllowCutroomEdits: false,
  });
  await expect(
    service.respond(session.id, {
      requestId: "shell",
      decision: "allow",
      alwaysAllowCutroomEdits: true,
    }),
  ).rejects.toThrow("only to Cutroom");
  expect(service.get(session.id).pendingRequest?.id).toBe("shell");
  const restored = await createAgentService({
    projects,
    review: createReviewService(projects),
    dataDir,
    runtimeFactory: runtime,
  });
  cleanup.push(() => restored.dispose());
  expect(await restored.permissions(project.id)).toEqual({
    alwaysAllowCutroomEdits: true,
  });
  const routes = createAgentRoutes(service);
  const revoked = await routes.request(
    `/projects/${project.id}/agent-permissions`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alwaysAllowCutroomEdits: false }),
    },
  );
  expect(revoked.status).toBe(200);
  expect(service.get(session.id).pendingRequest).toBeUndefined();
  expect(service.get(session.id).status).toBe("idle");
  expect(await service.permissions(project.id)).toEqual({
    alwaysAllowCutroomEdits: false,
  });
  expect(
    JSON.parse(await readFile(join(dataDir, "agents.json"), "utf8"))
      .cutroomEdits[project.id],
  ).toBe(false);
});

test("Codex uses privileged MCP approval metadata, honors explicit prompt rules, and never auto-answers server forms or other tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-mcp-permissions-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "provider.mjs");
  await writeFile(
    script,
    String.raw`
import {createInterface} from 'node:readline';
const reply = value => process.stdout.write(JSON.stringify(value)+'\n');
const requests = [
 ['cutroom_studio','timeline_edit',{commands:[{}, {}, {}]}],
 ['cutroom_studio','source_write',{path:'index.html'}],
 ['other','timeline_edit',{}],
 ['cutroom_studio',null,{}],
 ['cutroom_studio','unknown',{}],
];
let at = 0;
const next = () => {
  const entry = requests[at++];
  if (!entry) {reply({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});return;}
  const [serverName,tool,args] = entry;
  reply({id:at,method:'mcpServer/elicitation/request',params:{threadId:'thread',serverName,mode:'form',message:'Allow the raw MCP name?',requestedSchema:{type:'object',properties:{}},...(tool && {_meta:{codex_approval_kind:'mcp_tool_call',tool_name:tool,tool_params:args}})}});
};
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.method==='initialize')reply({id:m.id,result:{}});
 if(m.method==='config/read')reply({id:m.id,result:{config:{},layers:[{disabledReason:'Untrusted project',config:{mcp_servers:{cutroom_studio:{tools:process.argv[2]==='prompt'?{source_write:{approval_mode:'prompt'}}:{}}}}}]}});
 if(m.method==='thread/start')reply({id:m.id,result:{thread:{id:'thread'}}});
 if(m.method==='turn/start'){reply({id:m.id,result:{turn:{id:'turn'}}});next();}
 if(!m.method && m.result?.action)next();
}
`,
  );
  for (const prompt of [false, true]) {
    const client = new CodexClient({
      executable: process.execPath,
      args: [script, prompt ? "prompt" : "default"],
    });
    let always = false;
    const requests: AgentRequest[] = [];
    const runtime = new CodexRuntime(client, {
      cwd: directory,
      agentToken: "token",
      emit() {},
      allowCutroomEdits: () => always,
      request: async (request) => {
        requests.push(request);
        if (request.tool === "mcp__cutroom_studio__timeline_edit")
          always = true;
        return {
          requestId: request.id,
          decision: "allow",
          alwaysAllowCutroomEdits: request.canAllowCutroomEdits,
        };
      },
    });
    try {
      await runtime.send({ text: "Edit", skills: [], attachments: [] });
      expect(requests[0]?.title).toBe("Edit the timeline (3 changes)?");
      expect(requests[0]?.canAllowCutroomEdits).toBe(true);
      expect(
        requests.some(
          (request) => request.tool === "mcp__cutroom_studio__source_write",
        ),
      ).toBe(prompt);
      expect(
        requests.filter((request) => request.canAllowCutroomEdits),
      ).toHaveLength(1);
      expect(requests.map((request) => request.tool)).toContain(
        "mcp__other__timeline_edit",
      );
      expect(requests.map((request) => request.tool)).toContain(
        "mcpServer/elicitation/request",
      );
      expect(requests.map((request) => request.tool)).toContain(
        "mcp__cutroom_studio__unknown",
      );
    } finally {
      runtime.dispose();
      client.dispose();
    }
  }
});
