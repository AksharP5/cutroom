import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import type { AgentTurn } from "../src/shared/agent";
import { HttpError } from "../src/shared/errors";
import { AnnotationSchema } from "../src/shared/project";
import type { Project } from "../src/shared/project";
import { ReviewItemSchema, transition } from "../src/shared/review";
import type {
  Review,
  ReviewAction,
  ReviewActor,
  ReviewState,
  ReviewStatus,
} from "../src/shared/review";
import { createAgentService } from "../src/server/agents/service";
import type { AgentService } from "../src/server/agents/service";
import type { RuntimeFactory } from "../src/server/agents/runtime";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createReviewService } from "../src/server/projects/review";
import { createProjectRoutes } from "../src/server/projects/routes";
import { createProjectStore } from "../src/server/projects/store";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const human: ReviewActor = { kind: "human" };
const agent: ReviewActor = {
  kind: "agent",
  turn: { id: "message-1", kind: "message" },
};
const continuing: ReviewActor = {
  kind: "agent",
  turn: { id: "message-1", kind: "continuation" },
};
const outside: ReviewActor = {
  kind: "agent",
  turn: { id: "external:server", kind: "external" },
};
const at = "2026-01-01T00:00:00.000Z";
const reviews: Record<ReviewStatus, Review> = {
  open: { status: "open", updatedAt: at },
  queued: { status: "queued", updatedAt: at },
  working: { status: "working", updatedAt: at, turnId: "message-1" },
  done: {
    status: "done",
    updatedAt: at,
    note: "Title is 96px.",
    revision: null,
  },
  accepted: { status: "accepted", updatedAt: at },
  blocked: { status: "blocked", updatedAt: at, question: "Which logo?" },
  withdrawn: {
    status: "withdrawn",
    updatedAt: at,
    reason: "Owner changed course.",
    by: "agent",
  },
};
const state = (status: ReviewStatus): ReviewState => ({
  review: reviews[status],
  instructions: [],
});
const withdraw: ReviewAction = { type: "withdraw", reason: "Never mind." };
const claim: ReviewAction = { type: "claim" };
const complete: ReviewAction = { type: "complete", note: "Done." };

describe("review transitions", () => {
  test.each<[ReviewStatus, ReviewAction, ReviewActor, ReviewStatus]>([
    ["open", { type: "send" }, human, "queued"],
    ["queued", claim, agent, "working"],
    ["open", claim, outside, "working"],
    ["blocked", claim, agent, "working"],
    ["queued", claim, continuing, "working"],
    ["working", complete, agent, "done"],
    ["open", complete, outside, "done"],
    ["blocked", complete, agent, "done"],
    ["working", { type: "block", question: "Which?" }, agent, "blocked"],
    ["working", { type: "release" }, agent, "queued"],
    ["blocked", { type: "reply", note: "The blue one." }, human, "queued"],
    ["done", { type: "accept" }, human, "accepted"],
    ["done", { type: "reject", note: "Still too small." }, human, "queued"],
    ["queued", withdraw, agent, "withdrawn"],
    ["done", withdraw, agent, "withdrawn"],
    ["blocked", withdraw, outside, "withdrawn"],
    ["done", withdraw, human, "withdrawn"],
    ["open", withdraw, human, "withdrawn"],
    ["withdrawn", { type: "restore" }, human, "queued"],
  ])("%s --%o by %o--> %s", (from, action, actor, to) => {
    expect(transition(state(from), action, actor, at).review.status).toBe(to);
  });

  test.each<[ReviewStatus, ReviewAction, ReviewActor]>([
    ["open", { type: "send" }, agent],
    ["working", claim, agent],
    ["queued", claim, human],
    ["working", complete, human],
    ["done", { type: "accept" }, agent],
    ["queued", { type: "accept" }, human],
    ["done", { type: "reject", note: "No." }, agent],
    ["queued", { type: "reply", note: "Yes." }, human],
    ["open", withdraw, agent],
    ["accepted", withdraw, human],
    ["withdrawn", { type: "restore" }, agent],
    ["accepted", { type: "restore" }, human],
  ])("refuses %s --%o by %o", (from, action, actor) => {
    expect(() => transition(state(from), action, actor, at)).toThrow(HttpError);
  });

  test.each<[ReviewStatus, ReviewAction]>([
    ["queued", withdraw],
    ["done", withdraw],
    ["blocked", claim],
    ["blocked", complete],
    ["open", claim],
  ])(
    "an automatic continuation cannot act on the owner's word: %s --%o",
    (from, action) => {
      expect(() => transition(state(from), action, continuing, at)).toThrow(
        "Only a message from the owner",
      );
    },
  );

  test("records who withdrew a note, the message that did it, and its replacement", () => {
    expect(
      transition(
        state("queued"),
        { ...withdraw, replacedBy: "note-2" },
        agent,
        at,
      ).review,
    ).toEqual({
      status: "withdrawn",
      updatedAt: at,
      reason: "Never mind.",
      by: "agent",
      messageId: "message-1",
      replacedBy: "note-2",
    });
    expect(transition(state("queued"), withdraw, outside, at).review).toEqual({
      status: "withdrawn",
      updatedAt: at,
      reason: "Never mind.",
      by: "external",
    });
  });

  test("owner instructions accumulate and survive later transitions", () => {
    const sent = transition(
      state("done"),
      { type: "reject", note: "Bigger." },
      human,
      at,
    );
    const blocked = transition(
      transition(sent, claim, agent, at),
      { type: "block", question: "How much bigger?" },
      agent,
      at,
    );
    const answered = transition(
      blocked,
      { type: "reply", note: "Double it." },
      human,
      at,
    );
    const released = transition(
      transition(answered, claim, agent, at),
      { type: "release" },
      agent,
      at,
    );
    expect(released).toEqual({
      review: { status: "queued", updatedAt: at },
      instructions: [
        { text: "Bigger.", at },
        { text: "Double it.", at },
      ],
    });
  });
});

async function setup(
  run: (turn: AgentTurn, mcp: Client) => Promise<void> = async () => {},
  beforeCreate: () => void = () => {},
) {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-review-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = await createProjectStore({ dataDir: join(directory, "data") });
  cleanup.push(() => store.close());
  const review = createReviewService(store);
  const app = new Hono().route(
    "/api/cutroom",
    createProjectRoutes(store, undefined, review),
  );
  app.onError((error, c) =>
    c.json(
      { error: error.message },
      error instanceof HttpError ? error.status : 500,
    ),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => app.request(url, init),
    }),
  });
  cleanup.push(() => server.stop(true));
  const mcp = new Client({ name: "cutroom-review-test", version: "1.0.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
    ),
  );
  cleanup.push(() => mcp.close());
  const turns: AgentTurn[] = [];
  const runtimeFactory: RuntimeFactory = {
    capabilities: async (provider) => ({
      provider,
      available: true,
      skills: [],
      models: [],
      mcpServers: [],
    }),
    create: () => {
      beforeCreate();
      return {
        send: async (turn) => {
          turns.push(turn);
          await run(turn, mcp);
        },
        interrupt: async () => {},
        dispose: () => {},
      };
    },
    dispose: () => {},
  };
  const agents = await createAgentService({
    projects: store,
    review,
    dataDir: join(directory, "chat"),
    runtimeFactory,
  });
  cleanup.push(() => agents.dispose());
  const project = await store.create({ name: "Review queue" });
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await app.request(`/api/cutroom${path}`, {
      method,
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  const note = async (body: string, time = 0) =>
    AnnotationSchema.parse(
      await request(`/projects/${project.id}/annotations`, "POST", {
        kind: "comment",
        body,
        time,
      }),
    ).id;
  const items = async () =>
    z
      .object({ items: z.array(ReviewItemSchema) })
      .parse(await request(`/projects/${project.id}/review`)).items;
  const status = async () =>
    Object.fromEntries(
      (await items()).map((item) => [item.body, item.review.status]),
    );
  const fetchRaw = (path: string, method = "GET", body?: unknown) =>
    app.request(`/api/cutroom${path}`, {
      method,
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  return {
    fetchRaw,
    mcp,
    directory,
    store,
    review,
    agents,
    project,
    request,
    note,
    items,
    status,
    turns,
  };
}

async function settle(agents: AgentService, id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (agents.get(id).status === "idle") return;
    await Bun.sleep(10);
  }
  throw new Error("The agent never finished its turn.");
}

async function send(agents: AgentService, project: Project, text: string) {
  const session = await agents.create({
    projectId: project.id,
    provider: "codex",
  });
  await agents.send(session.id, { text, skills: [], attachments: [] });
  await settle(agents, session.id);
  return agents.get(session.id);
}

function call(mcp: Client, name: string, args: Record<string, unknown>) {
  return mcp.callTool({ name, arguments: args }).then((result) => {
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result;
  });
}

test("notes persist until the agent finishes or withdraws them, then the owner accepts", async () => {
  let ids: string[] = [];
  const queue = await setup(async (_turn, mcp) => {
    if (!ids.length) return;
    const projectId = queue.project.id;
    await call(mcp, "review_claim", { projectId, noteId: ids[0] });
    await call(mcp, "review_complete", {
      projectId,
      noteId: ids[0],
      note: "Moved the title up 40px.",
    });
    await call(mcp, "review_withdraw", {
      projectId,
      noteId: ids[1],
      reason: "The owner asked to keep the original color.",
    });
    await call(mcp, "review_claim", { projectId, noteId: ids[2] });
  });
  ids = [
    await queue.note("Move the title up", 1),
    await queue.note("Make the background red", 2),
    await queue.note("Fade the music out", 3),
    await queue.note("Trim the last second", 4),
  ];
  expect(Object.values(await queue.status())).toEqual([
    "open",
    "open",
    "open",
    "open",
  ]);
  const session = await send(
    queue.agents,
    queue.project,
    "Apply my notes, but never mind the red background.",
  );
  expect(await queue.status()).toEqual({
    "Move the title up": "done",
    "Make the background red": "withdrawn",
    // Claimed but unfinished when the run ended.
    "Fade the music out": "queued",
    "Trim the last second": "queued",
  });
  const withdrawn = (await queue.items()).find((item) => item.id === ids[1]);
  const message = session.messages.find((item) => item.role === "user");
  expect(withdrawn?.review).toMatchObject({
    status: "withdrawn",
    by: "agent",
    messageId: message?.id,
    reason: "The owner asked to keep the original color.",
  });
  const done = (await queue.items()).find((item) => item.id === ids[0]);
  expect(done?.review).toMatchObject({
    status: "done",
    note: "Moved the title up 40px.",
  });
  await queue.request(
    `/projects/${queue.project.id}/review/${ids[0]}/human`,
    "POST",
    { type: "accept" },
  );
  expect((await queue.status())["Move the title up"]).toBe("accepted");
  await expect(
    queue.request(
      `/projects/${queue.project.id}/review/${ids[0]}/agent`,
      "POST",
      {
        type: "withdraw",
        reason: "Not mine to withdraw.",
      },
    ),
  ).rejects.toThrow("The agent cannot withdraw a note that is accepted.");
});

test("an unrelated follow-up still carries every unfinished note", async () => {
  const queue = await setup();
  const first = await queue.note("Tighten the intro by half a second", 0.5);
  const second = await queue.note("Swap the logo for the white version", 6);
  await send(queue.agents, queue.project, "Start with the intro");
  await queue.request(
    `/projects/${queue.project.id}/review/${first}/agent`,
    "POST",
    { type: "block", question: "Cut from the start or the end?" },
  );
  await send(queue.agents, queue.project, "Also, what font is the title?");
  const digest = queue.turns.at(-1)?.context ?? "";
  expect(digest).toContain(`[blocked] ${first}`);
  expect(digest).toContain("You asked: Cut from the start or the end?");
  expect(digest).toContain(`[queued] ${second}`);
  expect(digest).toContain('"Swap the logo for the white version"');
  expect(digest).toContain("Reconcile this message with the queue");
  expect(await queue.status()).toEqual({
    "Tighten the intro by half a second": "blocked",
    "Swap the logo for the white version": "queued",
  });
});

test("a claim left by a closed run returns to the queue", async () => {
  const queue = await setup();
  const id = await queue.note("Raise the voiceover");
  await mkdir(join(queue.project.path, ".cutroom"));
  await writeFile(
    join(queue.project.path, ".cutroom", "review.json"),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          id,
          review: { status: "working", updatedAt: at, turnId: "gone" },
          instructions: [],
        },
      ],
    }),
  );
  expect((await queue.status())["Raise the voiceover"]).toBe("queued");
});

test("notes saved before the review queue keep their meaning", async () => {
  const queue = await setup();
  const legacy = (status: string, body: string) => ({
    id: body,
    kind: "comment",
    compositionPath: "index.html",
    body,
    time: 0,
    strokes: [],
    status,
    createdAt: at,
    updatedAt: at,
  });
  await writeFile(
    join(queue.project.path, "cutroom.json"),
    JSON.stringify({
      schemaVersion: 1,
      annotations: [
        legacy("open", "Unsent"),
        legacy("sent", "Sent earlier"),
        legacy("resolved", "Resolved earlier"),
      ],
      transcripts: [],
    }),
  );
  expect(await queue.status()).toEqual({
    Unsent: "open",
    "Sent earlier": "queued",
    "Resolved earlier": "accepted",
  });
  await send(queue.agents, queue.project, "Continue");
  expect(await queue.status()).toEqual({
    Unsent: "queued",
    "Sent earlier": "queued",
    "Resolved earlier": "accepted",
  });
});

test("review status stays out of undo while note content stays undoable", async () => {
  const queue = await setup();
  const id = await queue.note("Warm up the grade");
  await send(queue.agents, queue.project, "Go");
  await queue.request(`/projects/${queue.project.id}/history/undo`, "POST");
  expect(await queue.items()).toHaveLength(0);
  await queue.request(`/projects/${queue.project.id}/history/redo`, "POST");
  expect(
    (await queue.items()).find((item) => item.id === id)?.review.status,
  ).toBe("queued");
});

describe("review queue regressions", () => {
  test("owner instructions survive a claim and an interrupted run", async () => {
    const queue = await setup(async (_turn, mcp) => {
      const [item] = await queue.items();
      if (item?.review.status === "queued")
        await call(mcp, "review_claim", {
          projectId: queue.project.id,
          noteId: item.id,
        });
    });
    const id = await queue.note("Swap the logo");
    await send(queue.agents, queue.project, "Go");
    const base = `/projects/${queue.project.id}/review/${id}`;
    await queue.request(`${base}/agent`, "POST", {
      type: "block",
      question: "Which logo file?",
    });
    await queue.request(`${base}/human`, "POST", {
      type: "reply",
      note: "Use white-logo.svg",
    });
    await send(queue.agents, queue.project, "Keep going");
    expect(
      JSON.stringify(
        await queue.request(`/projects/${queue.project.id}/review`),
      ),
    ).toContain("Use white-logo.svg");
    await send(queue.agents, queue.project, "Anything else?");
    expect(queue.turns.at(-1)?.context).toContain("Use white-logo.svg");
  });

  test("a chat message can answer a blocked note", async () => {
    let answered = false;
    const queue = await setup(async (turn, mcp) => {
      if (!turn.text.includes("white")) return;
      const [item] = await queue.items();
      await call(mcp, "review_claim", {
        projectId: queue.project.id,
        noteId: item!.id,
      });
      await call(mcp, "review_complete", {
        projectId: queue.project.id,
        noteId: item!.id,
        note: "Swapped in the white logo.",
      });
      answered = true;
    });
    const id = await queue.note("Swap the logo");
    await send(queue.agents, queue.project, "Go");
    await queue.request(
      `/projects/${queue.project.id}/review/${id}/agent`,
      "POST",
      {
        type: "block",
        question: "Which logo file?",
      },
    );
    await send(queue.agents, queue.project, "Use the white one");
    expect(answered).toBe(true);
    expect((await queue.status())["Swap the logo"]).toBe("done");
  });

  test("an outside MCP client can work fresh notes, and its claims recover after a restart", async () => {
    const queue = await setup();
    const id = await queue.note("Tighten the intro");
    await call(queue.mcp, "review_claim", {
      projectId: queue.project.id,
      noteId: id,
    });
    expect((await queue.status())["Tighten the intro"]).toBe("working");
    const restarted = createReviewService(queue.store);
    const [item] = await restarted.list(
      queue.project,
      await queue.store.document(queue.project),
    );
    expect(item?.review.status).toBe("queued");
  });

  test("submitted notes must be withdrawn, not deleted", async () => {
    const queue = await setup();
    const fresh = await queue.note("Still a draft");
    const sent = await queue.note("Already sent");
    await queue.request(
      `/projects/${queue.project.id}/annotations/${fresh}`,
      "DELETE",
    );
    await send(queue.agents, queue.project, "Go");
    const refused = await queue.fetchRaw(
      `/projects/${queue.project.id}/annotations/${sent}`,
      "DELETE",
    );
    expect(refused.status).toBe(409);
    expect(await queue.status()).toEqual({ "Already sent": "queued" });
  });

  test("one conversation per project works at a time", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = await setup(() => held);
    const first = await queue.agents.create({
      projectId: queue.project.id,
      provider: "codex",
    });
    const second = await queue.agents.create({
      projectId: queue.project.id,
      provider: "claude",
    });
    await queue.agents.send(first.id, {
      text: "One",
      skills: [],
      attachments: [],
    });
    await expect(
      queue.agents.send(second.id, {
        text: "Two",
        skills: [],
        attachments: [],
      }),
    ).rejects.toThrow("A conversation in this project is already working");
    release();
    await settle(queue.agents, first.id);
  });

  test("agent withdrawal follows one rule across turn kinds", async () => {
    const queue = await setup();
    const done = await queue.note("Bigger title");
    const outside = await queue.note("Red background");
    await send(queue.agents, queue.project, "Go");
    const base = `/projects/${queue.project.id}/review`;
    await queue.request(`${base}/${done}/agent`, "POST", {
      type: "complete",
      note: "Title is 96px.",
    });
    await queue.request(`${base}/${outside}/agent`, "POST", {
      type: "withdraw",
      reason: "The owner said so in their terminal.",
    });
    const withdrew = (await queue.items()).find(
      (item) => item.id === outside,
    )?.review;
    expect(withdrew).toMatchObject({ status: "withdrawn", by: "external" });
    expect(withdrew).not.toHaveProperty("messageId");
    const doneWithdraw = await queue.fetchRaw(`${base}/${done}/agent`, "POST", {
      type: "withdraw",
      reason: "Never mind the title change.",
    });
    expect(doneWithdraw.status).toBe(200);
  });

  test("migrating a legacy status removes it from cutroom.json", async () => {
    const queue = await setup();
    await writeFile(
      join(queue.project.path, "cutroom.json"),
      JSON.stringify({
        schemaVersion: 1,
        annotations: [
          {
            id: "legacy",
            kind: "comment",
            compositionPath: "index.html",
            body: "Sent earlier",
            time: 0,
            strokes: [],
            status: "sent",
            createdAt: at,
            updatedAt: at,
          },
        ],
        transcripts: [],
      }),
    );
    expect(
      JSON.stringify(
        await queue.request(`/projects/${queue.project.id}/document`),
      ),
    ).not.toContain('"status"');
    await send(queue.agents, queue.project, "Go");
    expect(
      await Bun.file(join(queue.project.path, "cutroom.json")).text(),
    ).not.toContain('"status"');
    expect(await queue.status()).toEqual({ "Sent earlier": "queued" });
  });

  test("a failed runtime start does not leave the review turn registered", async () => {
    let fail = true;
    const queue = await setup(undefined, () => {
      if (fail) {
        fail = false;
        throw new Error("The native agent could not start.");
      }
    });
    const id = await queue.note("Raise the voiceover");
    const session = await queue.agents.create({
      projectId: queue.project.id,
      provider: "codex",
    });
    await expect(
      queue.agents.send(session.id, {
        text: "Go",
        skills: [],
        attachments: [],
      }),
    ).rejects.toThrow("could not start");
    await queue.request(
      `/projects/${queue.project.id}/review/${id}/agent`,
      "POST",
      {
        type: "withdraw",
        reason: "Not needed.",
      },
    );
    expect((await queue.items())[0]?.review).not.toHaveProperty("messageId");
  });

  test("a corrupt review file leaves transcripts and chat working", async () => {
    const queue = await setup();
    await queue.note("Warm the grade");
    await mkdir(join(queue.project.path, ".cutroom"));
    await writeFile(
      join(queue.project.path, ".cutroom", "review.json"),
      "{oops",
    );
    const notebook = await queue.fetchRaw(
      `/projects/${queue.project.id}/notebook`,
    );
    expect(notebook.status).toBe(200);
    const body = z
      .object({ transcriptVersion: z.string(), reviewError: z.string() })
      .parse(await notebook.json());
    expect(body.reviewError).toContain("review.json");
    const session = await send(queue.agents, queue.project, "Hello");
    expect(session.status).toBe("idle");
    expect(queue.turns.at(-1)?.context).toContain("unavailable");
  });
});
