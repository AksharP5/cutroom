import assert from "node:assert/strict";
import { join } from "node:path";
import { createNativeRuntimeFactory } from "../../src/server/agents/factory";
import { createAgentService } from "../../src/server/agents/service";
import type { ToolNames } from "../../src/server/agents/tool-subject";
import type { AgentEvent } from "../../src/shared/agent";
import { agentProviderSchema } from "../../src/shared/agent";
import { projectFixture } from "../project-fixture";

const provider = agentProviderSchema.parse(process.argv[2]);
const fixture = await projectFixture();
const native = createNativeRuntimeFactory();
type Clips = Awaited<ReturnType<ToolNames["clips"]>>;
const late = Promise.withResolvers<Clips>();
let lookup = late.promise;
const named: Clips = new Map([
  ["title", { label: "Title", src: null, kind: "element" }],
]);
const service = await createAgentService({
  projects: fixture.store,
  review: fixture.review,
  dataDir: join(process.argv[3]!, "chat"),
  runtimeFactory: {
    ...native,
    create: (provider, options) =>
      native.create(provider, {
        ...options,
        names: {
          note: async () => undefined,
          transcript: async () => undefined,
          clips: () => lookup,
        },
      }),
  },
});
const project = await fixture.store.create({ name: "Naming regression" });
const session = await service.create({ projectId: project.id, provider });
const events: AgentEvent[] = [];
service.subscribe(session.id, ({ event }) => events.push(event));
const state = () => service.get(session.id);
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert(Date.now() < deadline, `Timed out: ${JSON.stringify(state())}`);
    await Bun.sleep(5);
  }
};
const send = () =>
  service.send(session.id, {
    text: "Check naming",
    skills: [],
    attachments: [],
  });
try {
  await send();
  await waitFor(() =>
    state().messages.some((message) => message.text === "Still streaming 1"),
  );
  assert.equal(state().status, "running");
  const row = state().messages.find((message) => message.id === "edit");
  assert.equal(row?.role, "tool");
  assert.equal(row?.target, undefined);
  await service.interrupt(session.id);
  await waitFor(() => state().status === "idle");

  // The next run must be admitted. Both its row and its approval lookup never resolve.
  lookup = new Promise(() => {});
  await send();
  await waitFor(() =>
    state().messages.some((message) => message.text === "Still streaming 2"),
  );
  await waitFor(() => state().status === "waiting");
  assert.equal(state().pendingRequest?.title, "Edit a clip?");
  // A name from the cancelled run must not rename the reused call id in this run.
  const beforeLate = events.length;
  late.resolve(named);
  await Bun.sleep(30);
  assert.equal(events.length, beforeLate);
  await service.respond(session.id, {
    requestId: state().pendingRequest!.id,
    decision: "deny",
  });
  await waitFor(() => state().status === "idle");
  assert(
    state().messages.some(
      (message) => message.text === "Still streaming 2 after approval",
    ),
  );

  // A name arriving during a live turn updates the existing result, never its old input.
  const upgrade = Promise.withResolvers<Clips>();
  lookup = upgrade.promise;
  await send();
  await waitFor(() =>
    state().messages.some((message) => message.text === "Still streaming 3"),
  );
  const result = state().messages.findLast((message) => message.id === "edit");
  assert.equal(result?.status, "complete");
  upgrade.resolve(named);
  await waitFor(
    () =>
      state().messages.findLast((message) => message.id === "edit")?.target ===
      "Title",
  );
  const updated = state().messages.findLast((message) => message.id === "edit");
  assert.equal(updated?.text, result?.text);
  assert.equal(updated?.status, result?.status);
  assert.equal(updated?.createdAt, result?.createdAt);
  await service.interrupt(session.id);
  await waitFor(() => state().status === "idle");

  const finished = Promise.withResolvers<Clips>();
  lookup = finished.promise;
  await send();
  await waitFor(() =>
    state().messages.some((message) => message.text === "Still streaming 4"),
  );
  await waitFor(() => state().status === "idle");
  const beforeFinished = events.length;
  finished.resolve(named);
  await Bun.sleep(30);
  assert.equal(events.length, beforeFinished);
  console.log("passed");
} finally {
  await service.dispose();
  await fixture.close();
}
