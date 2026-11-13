import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server/mcp/server";
import { agentPrompt } from "../src/server/agents/runtime";
import { agentTurnSchema } from "../src/shared/agent";

test("native agents and MCP clients allow explicit note questions and blocker explanations", async () => {
  const expected = [
    "when this turn changed one",
    "when the user explicitly asks about review notes",
    "when needed to explain a blocker",
    "Otherwise do not recap untouched notes",
  ];
  const prompt = agentPrompt(
    agentTurnSchema.parse({
      text: "Which review notes are still queued? Do not change anything.",
    }),
    "/tmp/project",
  );
  for (const instruction of expected) expect(prompt).toContain(instruction);
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
