import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server/mcp/server";
import { agentInstructions } from "../src/server/agents/runtime";

test("native agents and MCP clients allow explicit note questions and blocker explanations", async () => {
  const expected = [
    "when this turn changed one",
    "when the user explicitly asks about review notes",
    "when needed to explain a blocker",
    "Otherwise do not recap untouched notes",
  ];
  const instructions = agentInstructions("/tmp/project");
  for (const instruction of expected)
    expect(instructions).toContain(instruction);
  const server = createMcpServer();
  const client = new Client({ name: "reply-guidance", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(remote);
    await client.connect(local);
    for (const instruction of expected)
      expect(client.getInstructions()).toContain(instruction);
  } finally {
    await client.close();
    await server.close();
  }
});
