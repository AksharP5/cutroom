import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server/mcp/server";
import { agentPrompt } from "../src/server/agents/runtime";
import { agentTurnSchema } from "../src/shared/agent";

test("native agents and MCP clients are told to mention only review notes changed this turn", async () => {
  const expected =
    "Mention review notes in your reply only when this turn changed one.";
  const prompt = agentPrompt(
    agentTurnSchema.parse({ text: "Add a marker. Do nothing else." }),
    "/tmp/project",
  );
  expect(prompt).toContain(expected);
  const server = createMcpServer();
  const client = new Client({ name: "reply-guidance", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(remote);
    await client.connect(local);
    expect(client.getInstructions()).toContain(expected);
  } finally {
    await client.close();
    await server.close();
  }
});
