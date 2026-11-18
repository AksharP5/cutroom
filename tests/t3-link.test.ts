import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentSession } from "../src/shared/agent";
import { createAgentRoutes } from "../src/server/agents/routes";
import { createAgentService } from "../src/server/agents/service";
import { threadMessages } from "../src/server/agents/t3-link";
import type { T3Runner } from "../src/server/agents/t3-link";
import {
  addAnnotation,
  createReviewService,
} from "../src/server/projects/review";
import { createProjectStore } from "../src/server/projects/store";

// Fields retained from the isolated CLI's list and show output on a synthetic thread.
const cliThread = {
  threadId: "mcp:299c562b-fcf8-43be-9ee4-76ea289ed0b1",
  title: "Reply with the single word started.",
  status: "completed",
  link: "https://app.t3.codes/threads/test/mcp%3A299c562b-fcf8-43be-9ee4-76ea289ed0b1",
  providerInstanceId: "codex",
  model: "gpt-6-sol",
  createdAt: "2026-11-18T02:52:51.344Z",
  updatedAt: "2026-11-18T02:52:56.204Z",
};
const runId = "run:thread:mcp%3A299c562b-fcf8-43be-9ee4-76ea289ed0b1:ordinal:1";
const cliShow = {
  thread: {
    ...cliThread,
    activeRunId: null,
    latestRunId: runId,
    pendingRequestCount: 0,
    archived: false,
  },
  messages: [
    { role: "user", runId, text: "Reply with the single word started.\n" },
    { role: "assistant", runId, text: "started" },
  ],
};
const ok = (body: unknown) => ({
  code: 0,
  stdout: JSON.stringify(body),
  stderr: "",
});

test("a sliding T3 window keeps message IDs as a reply grows and after it finishes", () => {
  const thread = { ...cliShow.thread, activeRunId: runId };
  const earlier = { role: "assistant", runId, text: "I will check." } as const;
  const growing = { role: "assistant", runId, text: "The result is" } as const;
  const initial = threadMessages({ thread, messages: [earlier, growing] });
  const [first, second] = initial;
  if (!first || !second) throw new Error("Expected two mirrored messages");
  const afterSlide = threadMessages(
    {
      thread,
      messages: [
        { ...growing, text: "The result is cobalt." },
        { role: "tool", runId, text: "Done." },
      ],
    },
    initial,
  );
  expect(afterSlide[0]?.id).toBe(second.id);
  expect(afterSlide[0]?.text).toBe("The result is cobalt.");
  const afterCompletion = threadMessages(
    {
      thread: cliShow.thread,
      messages: [
        { role: "tool", runId, text: "Done." },
        { role: "assistant", runId, text: "Final answer." },
      ],
    },
    [first, ...afterSlide],
  );
  expect(afterCompletion[0]?.id).toBe(afterSlide[1]?.id);
  expect(initial.map(({ id }) => id)).not.toContain(afterCompletion[1]?.id);
  expect(new Set(afterCompletion.map(({ createdAt }) => createdAt))).toEqual(
    new Set([cliThread.createdAt]),
  );
});

test("a linked chat mirrors T3 and sends review context while a local run owns the project", async () => {
  const cache = join(homedir(), ".cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "cutroom-t3-test-"));
  const projects = await createProjectStore({ dataDir: directory });
  try {
    const project = await projects.create({ name: "Synthetic chat" });
    const review = createReviewService(projects);
    const legacy: AgentSession = {
      id: "legacy",
      projectId: project.id,
      title: "Existing native chat",
      provider: "codex",
      status: "idle",
      createdAt: cliThread.createdAt,
      updatedAt: cliThread.updatedAt,
      nativeSessionId: "synthetic-native-id",
      messages: [],
    };
    await writeFile(
      join(directory, "agents.json"),
      JSON.stringify({ version: 1, sessions: [legacy] }),
    );
    let unavailable = false;
    let sent: string | undefined;
    let waiting = false;
    let shows = 0;
    let pollSignal: AbortSignal | undefined;
    const runner: T3Runner = async (args, stdin, signal) => {
      if (unavailable)
        return {
          code: 1,
          stdout: "",
          stderr:
            "No running T3 Code server uses /synthetic/t3. Start T3 Code, then retry.",
        };
      if (args[1] === "list") {
        expect(args.slice(0, 4)).toEqual([
          "thread",
          "list",
          "--project",
          project.path,
        ]);
        return ok([cliThread]);
      }
      if (args[1] === "show") {
        expect(args.slice(0, 5)).toEqual([
          "thread",
          "show",
          "--messages",
          "40",
          cliThread.threadId,
        ]);
        shows++;
        pollSignal = signal;
        if (!sent) return ok(cliShow);
        return ok({
          thread: {
            ...cliShow.thread,
            status: waiting ? "running" : "completed",
            activeRunId: waiting ? "next" : null,
            pendingRequestCount: waiting ? 1 : 0,
          },
          messages: [
            ...cliShow.messages,
            { role: "assistant", runId: "next", text: "Can I proceed?" },
          ],
        });
      }
      expect(args.slice(0, 4)).toEqual([
        "thread",
        "send",
        cliThread.threadId,
        "-",
      ]);
      expect(args.join(" ")).not.toContain("new message");
      sent = stdin;
      waiting = true;
      return ok({
        threadId: cliThread.threadId,
        delivery: "queued",
        status: "running",
      });
    };
    const newService = () =>
      createAgentService({
        projects,
        review,
        dataDir: directory,
        t3Runner: runner,
        runtimeFactory: {
          capabilities: async () => {
            throw new Error("Unexpected native discovery");
          },
          create: () => {
            throw new Error("Unexpected native run");
          },
          dispose: () => {},
        },
      });
    const service = await newService();
    try {
      expect(service.get(legacy.id)).toEqual(legacy);
      const api = createAgentRoutes(service);
      const listPath = `/projects/${project.id}/t3-threads`;
      expect(await (await api.request(listPath)).json()).toEqual({
        available: true,
        threads: [cliThread],
      });
      const link = () =>
        api.request(`${listPath}/link`, {
          method: "POST",
          body: JSON.stringify({ threadId: cliThread.threadId }),
        });
      const [first, second] = await Promise.all([link(), link()]);
      expect(first.status).toBe(201);
      const session = service.list(project.id).find((chat) => chat.t3Thread);
      if (!session) throw new Error("Linked chat was not saved");
      expect((await first.json()).id).toBe(session.id);
      expect((await second.json()).id).toBe(session.id);
      expect(
        service.get(session.id).messages.map(({ text }) => text.trim()),
      ).toEqual([cliThread.title, "started"]);
      const showsAfterLink = shows;
      await Bun.sleep(25);
      expect(shows).toBe(showsAfterLink);

      const local = await review.beginTurn(project, {
        kind: "message",
        id: "local",
        token: "local-token",
      });
      try {
        const note = await addAnnotation(projects, project, {
          kind: "comment",
          body: "Move the synthetic slate",
          time: 1,
          compositionPath: "index.html",
          strokes: [],
        });
        const frame = join(project.path, "synthetic.png");
        await writeFile(frame, "synthetic frame");
        await review.attachFrame(project, note.id, frame);

        const events: AgentEvent[] = [];
        const unsubscribe = service.subscribe(session.id, ({ event }) =>
          events.push(event),
        );
        const secondSubscriber = service.subscribe(session.id, () => {});
        try {
          expect(shows).toBe(showsAfterLink + 1);
          const response = await service.queueFollowUp(session.id, {
            text: "new message",
            context: "Playhead: 1",
            skills: [],
            attachments: [{ path: join(project.path, "index.html") }],
          });
          expect(response).toHaveProperty("queued", true);
          // The owner's words come first, then the project T3 Code is asked to work on.
          expect(sent).toStartWith(
            `new message\n\n<cutroom-context>\nFrom Cutroom, project ${project.name} at ${project.path}.`,
          );
          expect(sent).toContain(`[queued] ${note.id}`);
          expect(sent).toContain("Move the synthetic slate");
          expect(sent).toContain("Playhead: 1");
          expect(sent).toContain(
            `Attached local files:\n${join(project.path, "index.html")}\n${frame}`,
          );
          const deadline = Date.now() + 500;
          while (
            service.get(session.id).status !== "waiting" &&
            Date.now() < deadline
          )
            await Bun.sleep(5);
          expect(service.get(session.id).status).toBe("waiting");
          expect(events).toContainEqual({ type: "status", status: "waiting" });
          expect(
            events
              .filter((event) => event.type === "message")
              .map(({ message }) => message.text),
          ).toEqual(["Can I proceed?", "Answer in T3 Code."]);
          expect((await review.list(project))[0]?.review.status).toBe("queued");
        } finally {
          secondSubscriber();
          expect(pollSignal?.aborted).toBe(false);
          unsubscribe();
          expect(pollSignal?.aborted).toBe(true);
        }
        const interruption = await api.request(
          `/agents/sessions/${session.id}/interrupt`,
          { method: "POST" },
        );
        expect(interruption.status).toBe(409);
        expect(await interruption.json()).toEqual({
          error: "Stop this run in T3 Code.",
        });
      } finally {
        await local.end();
      }
      await service.dispose();
      const restarted = await newService();
      try {
        expect(restarted.get(session.id)).toEqual(service.get(session.id));
        waiting = false;
        const stop = restarted.subscribe(session.id, () => {});
        try {
          const deadline = Date.now() + 500;
          while (
            restarted.get(session.id).status === "waiting" &&
            Date.now() < deadline
          )
            await Bun.sleep(5);
          expect(restarted.get(session.id).status).toBe("idle");
          expect(
            restarted.get(session.id).messages.map(({ text }) => text.trim()),
          ).toEqual([
            cliThread.title,
            "started",
            "Can I proceed?",
            "Answer in T3 Code.",
          ]);
        } finally {
          stop();
        }
        unavailable = true;
        const restartedApi = createAgentRoutes(restarted);
        expect(await (await restartedApi.request(listPath)).json()).toEqual({
          available: false,
          threads: [],
          reason: "Start T3 Code, then try again.",
        });
      } finally {
        await restarted.dispose();
      }
    } finally {
      await service.dispose();
    }
  } finally {
    await projects.close();
    await rm(directory, { recursive: true, force: true });
  }
});
