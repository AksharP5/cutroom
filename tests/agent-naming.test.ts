import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both transports send a tool call, text, and a later approval while project naming is held.
const fakeCodex = String.raw`
import { createInterface } from "node:readline";
const reply = value => process.stdout.write(JSON.stringify(value) + "\n");
let turn = 0;
const event = (method, params) => reply({method, params:{threadId:"session", turnId:String(turn), ...params}});
const complete = () => event("turn/completed", {turn:{id:String(turn),status:"completed"}});
for await (const line of createInterface({input:process.stdin})) {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply({id:message.id,result:{}});
  if (message.method === "config/read") reply({id:message.id,result:{config:{}}});
  if (message.method === "thread/start") reply({id:message.id,result:{thread:{id:"session"}}});
  if (message.method === "turn/start") {
    turn++;
    reply({id:message.id,result:{turn:{id:String(turn)}}});
    const item = {id:"edit",type:"mcpToolCall",server:"cutroom_studio",tool:"timeline_edit",arguments:{projectId:"p",expectedRevision:"r",commands:[{type:"setClip",clipId:"title",fadeIn:9}]}};
    event("item/started", {item});
    if (turn === 3) event("item/completed", {item:{...item,result:{saved:true}}});
    event("item/agentMessage/delta", {itemId:"text-"+turn,delta:"Still streaming "+turn});
    if (turn === 2) reply({id:"approval",method:"mcpServer/elicitation/request",params:{threadId:"session",serverName:"cutroom_studio",_meta:{codex_approval_kind:"mcp_tool_call",tool_name:"timeline_edit",tool_params:item.arguments}}});
    if (turn === 4) complete();
  }
  if (message.id === "approval") {
    event("item/agentMessage/delta", {itemId:"text-2",delta:" after approval"});
    complete();
  }
  if (message.method === "turn/interrupt") {
    reply({id:message.id,result:{}});
    complete();
  }
}
`;

const fakeClaude = String.raw`
import { createInterface } from "node:readline";
const reply = value => process.stdout.write(JSON.stringify({session_id:"session",...value}) + "\n");
let turn = 0;
const complete = () => reply({type:"result",subtype:"success",is_error:false,result:"Done"});
const delta = text => reply({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text}}});
for await (const line of createInterface({input:process.stdin})) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    reply({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{}}});
    if (message.request.subtype === "interrupt") complete();
  }
  if (message.type === "user") {
    turn++;
    const input = {projectId:"p",expectedRevision:"r",commands:[{type:"setClip",clipId:"title",fadeIn:9}]};
    reply({type:"assistant",message:{id:"tools-"+turn,role:"assistant",content:[{type:"tool_use",id:"edit",name:"mcp__cutroom_studio__timeline_edit",input}]}});
    if (turn === 3) reply({type:"user",message:{role:"user",content:[{type:"tool_result",tool_use_id:"edit",content:'{"saved":true}'}]}});
    reply({type:"stream_event",event:{type:"message_start",message:{id:"text-"+turn}}});
    delta("Still streaming "+turn);
    if (turn === 2) reply({type:"control_request",request_id:"approval",request:{subtype:"can_use_tool",tool_name:"mcp__cutroom_studio__timeline_edit",input,tool_use_id:"edit"}});
    if (turn === 4) complete();
  }
  if (message.type === "control_response" && message.response.request_id === "approval") {
    delta(" after approval");
    complete();
  }
}
`;

test.each(["codex", "claude"])(
  "%s keeps streaming, cancels, accepts the next message, and shows approvals with a stuck clip lookup",
  async (provider) => {
    const directory = await mkdtemp(join(tmpdir(), "cutroom-naming-"));
    try {
      const executable = join(directory, provider);
      await writeFile(
        executable,
        `#!${process.execPath}\n${provider === "codex" ? fakeCodex : fakeClaude}`,
      );
      await chmod(executable, 0o755);
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures/agent-naming-runner.ts"),
          provider,
          directory,
        ],
        {
          cwd: directory,
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        const [output, error, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, `${output}\n${error}`).toBe(0);
        expect(output.trim()).toBe("passed");
      } finally {
        clearTimeout(timeout);
        child.kill();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
