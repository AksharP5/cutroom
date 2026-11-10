import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpServer } from "../src/server/mcp/server";
import {
  claudeToolPermissions,
  codexToolPermissions,
} from "../src/server/agents/tool-permissions";

const reads = [
  "projects_list",
  "project_read",
  "media_list",
  "source_read",
  "transcripts_list",
  "transcription_status",
  "history_list",
  "review_list",
  "timeline_read",
];

test("native permission rules match every tool advertised over MCP", async () => {
  const server = createMcpServer();
  const client = new Client({ name: "permissions-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(remote);
    await client.connect(local);
    const { tools } = await client.listTools();
    expect(
      tools
        .filter((tool) => tool.annotations?.readOnlyHint)
        .map((tool) => tool.name),
    ).toEqual(reads);
    for (const tool of tools) {
      const name = `mcp__cutroom_studio__${tool.name}`;
      const readOnly = reads.includes(tool.name);
      expect(claudeToolPermissions.allowedTools.includes(name)).toBe(readOnly);
      expect(
        claudeToolPermissions.settings.permissions.ask.includes(name),
      ).toBe(!readOnly);
      const mode =
        codexToolPermissions[
          `mcp_servers.cutroom_studio.tools.${tool.name}.approval_mode`
        ];
      if (readOnly) expect(mode).toBe("approve");
      else expect(mode).toBeUndefined();
    }
    expect(claudeToolPermissions.allowedTools).toHaveLength(reads.length);
    expect(claudeToolPermissions.settings.permissions.ask).toHaveLength(
      tools.length - reads.length,
    );
    expect(
      codexToolPermissions[
        "mcp_servers.cutroom_studio.default_tools_approval_mode"
      ],
    ).toBe("prompt");
    expect(Object.keys(codexToolPermissions)).toHaveLength(reads.length + 1);
  } finally {
    await client.close();
    await server.close();
  }
});

// Capture the native configuration without simulating either runtime's permission decisions.
const fakeClaude = String.raw`
import { createInterface } from "node:readline";
const reply = value => process.stdout.write(JSON.stringify(value) + "\n");
await Bun.write(process.env.RECORDING + ".args", JSON.stringify(process.argv));
for await (const line of createInterface({input:process.stdin})) {
  const message = JSON.parse(line);
  if (message.type === "control_request")
    reply({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{}}});
  if (message.type === "user")
    reply({type:"result",subtype:"success",is_error:false,result:"Done",session_id:"test-session"});
}
`;

const fakeCodex = String.raw`
import { createInterface } from "node:readline";
const reply = value => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of createInterface({input:process.stdin})) {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply({id:message.id,result:{}});
  if (message.method === "thread/start" || message.method === "thread/resume") {
    await Bun.write(process.env.RECORDING + ".thread", JSON.stringify(message.params));
    reply({id:message.id,result:{thread:{id:"test-thread"}}});
  }
  if (message.method === "turn/start") {
    reply({id:message.id,result:{turn:{id:"test-turn"}}});
    reply({method:"turn/completed",params:{threadId:"test-thread",turn:{id:"test-turn",status:"completed"}}});
  }
}
`;

test("native factories wire scoped rules into fresh and resumed sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-permissions-"));
  try {
    for (const [name, source] of [
      ["claude", fakeClaude],
      ["codex", fakeCodex],
    ]) {
      const path = join(directory, name);
      await writeFile(path, `#!${process.execPath}\n${source}`);
      await chmod(path, 0o755);
    }
    const runner = join(directory, "run.mjs");
    await writeFile(
      runner,
      `import { createNativeRuntimeFactory } from ${JSON.stringify(join(import.meta.dir, "../src/server/agents/factory.ts"))};
const factory = createNativeRuntimeFactory();
const runtime = factory.create(process.argv[2], {
  cwd: process.cwd(), agentToken: "test-token", nativeSessionId: process.argv[3], emit() {},
  request: async () => { throw new Error("The wiring fixture must not request approval"); }
});
try {
  await runtime.send({text:"Check tool permissions",skills:[],attachments:[]});
  console.log("done");
} finally { runtime.dispose(); factory.dispose(); }
`,
    );
    for (const provider of ["claude", "codex"] as const) {
      for (const resume of [false, true]) {
        const recording = join(directory, `${provider}-${resume}`);
        const child = Bun.spawn(
          [
            process.execPath,
            runner,
            provider,
            ...(resume ? ["previous-session"] : []),
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              PATH: `${directory}:${process.env.PATH}`,
              RECORDING: recording,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [output, error, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, error).toBe(0);
        expect(output.trim()).toBe("done");
        if (provider === "claude") {
          const args: string[] = JSON.parse(
            await readFile(`${recording}.args`, "utf8"),
          );
          expect(args).toContain("--permission-mode=default");
          expect(
            args
              .find((arg) => arg.startsWith("--allowedTools="))
              ?.slice("--allowedTools=".length)
              .split(","),
          ).toEqual(claudeToolPermissions.allowedTools);
          expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual(
            claudeToolPermissions.settings,
          );
        } else {
          const thread = JSON.parse(
            await readFile(`${recording}.thread`, "utf8"),
          );
          expect(thread.approvalPolicy).toBe("on-request");
          expect(thread.sandbox).toBe("workspace-write");
          expect(thread.config).toEqual({
            ...codexToolPermissions,
            "mcp_servers.cutroom_studio.env.CUTROOM_AGENT_TOKEN": "test-token",
          });
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
