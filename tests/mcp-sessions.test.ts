import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpHandler } from "../src/server/mcp/server";

const idle = 30 * 60 * 1000;
function manualClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  return {
    after(delay: number, run: () => void) {
      const id = next++;
      timers.set(id, { at: now + delay, run });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
    pending: () => timers.size,
  };
}
const base = "http://127.0.0.1:4930/mcp";
function request(id: string, method = "POST") {
  return new Request(base, {
    method,
    headers: {
      "mcp-session-id": id,
      "mcp-protocol-version": "2025-03-26",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    ...(method === "POST" && {
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    }),
  });
}
async function connect(handler: ReturnType<typeof createMcpHttpHandler>) {
  const client = new Client({ name: "Idle session regression", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(base), {
    fetch: async (url, init) => handler(new Request(url, init)),
  });
  await client.connect(transport);
  return { client, id: transport.sessionId! };
}

test("150 disconnected SDK clients expire and server.close ends their streams", async () => {
  const clock = manualClock();
  const handler = createMcpHttpHandler({}, clock);
  const ids: string[] = [];
  try {
    for (let i = 0; i < 150; i++) {
      const { client, id } = await connect(handler);
      ids.push(id);
      await client.close();
    }
    const initialized = await handler(
      new Request(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "Expiry stream", version: "1" },
          },
        }),
      }),
    );
    await initialized.text();
    const stream = await handler(
      request(initialized.headers.get("mcp-session-id")!, "GET"),
    );
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    clock.advance(idle);
    expect((await handler(request(ids[0]!))).status).toBe(404);
    expect((await handler(request(ids.at(-1)!))).status).toBe(404);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(clock.pending()).toBe(0);
  } finally {
    await handler.dispose();
  }
});

test("activity refreshes only that session's idle deadline and disposal cancels expiry", async () => {
  const clock = manualClock();
  const handler = createMcpHttpHandler({}, clock);
  try {
    const a = await connect(handler);
    const b = await connect(handler);
    await a.client.close();
    await b.client.close();
    clock.advance(idle - 1);
    expect((await handler(request(a.id))).status).toBe(200);
    clock.advance(1);
    expect((await handler(request(b.id))).status).toBe(404);
    expect((await handler(request(a.id))).status).toBe(200);
    await handler.dispose();
    expect(clock.pending()).toBe(0);
    expect((await handler(request(a.id))).status).toBe(404);
  } finally {
    await handler.dispose();
  }
});

test("a running tool cannot expire, and its completion starts a fresh idle period", async () => {
  const clock = manualClock();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const handler = createMcpHttpHandler(
    {
      fetch: async () => {
        entered.resolve();
        await release.promise;
        return Response.json({ projects: [] });
      },
    },
    clock,
  );
  const { client, id } = await connect(handler);
  try {
    const working = client.callTool({ name: "projects_list", arguments: {} });
    await entered.promise;
    clock.advance(idle * 2);
    expect(clock.pending()).toBe(0);
    release.resolve();
    expect((await working).isError).not.toBe(true);
    await client.close();
    clock.advance(idle);
    expect((await handler(request(id))).status).toBe(404);
  } finally {
    release.resolve();
    await client.close();
    await handler.dispose();
  }
});
