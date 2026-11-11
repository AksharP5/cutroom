import {
  safeParse,
  getParseErrorMessage,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import {
  CUTROOM_SERVER,
  describeTool,
  parseTool,
  runsCommand,
} from "../../shared/toolRow";
import { cutroomToolRegistry } from "./tool-permissions";
import { toolSubject } from "./tool-subject";
import type { ToolNames } from "./tool-subject";

// The field of each native tool's input that names what it acts on.
const nativeTargets: Record<string, string> = {
  Bash: "command",
  Shell: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  WebFetch: "url",
};

const oneLine = (value: unknown, limit = 200) => {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};
const plural = (total: number, one: string) =>
  `${total} ${total === 1 ? one : `${one}s`}`;

/** The one more line an owner needs to decide on a Cutroom tool call, from its own arguments. */
function approvalDetail(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "timeline_edit":
      return Array.isArray(args.commands) && args.commands.length > 1
        ? plural(args.commands.length, "change")
        : undefined;
    case "transcript_edit":
      return Array.isArray(args.wordIds)
        ? `${args.action === "restore" ? "Restore" : "Cut"} ${plural(args.wordIds.length, "word")}`
        : undefined;
    case "review_complete":
    case "review_send_back":
    case "review_reply":
      return oneLine(args.note);
    case "review_block":
      return oneLine(args.question);
    case "review_withdraw":
      return oneLine(args.reason);
    case "review_claim":
      return oneLine(args.answer);
    case "review_add":
    case "annotation_add":
      return oneLine(args.body);
    case "export_start": {
      const folder = oneLine(args.directory);
      return (
        [oneLine(args.filename), folder && `in ${folder}`]
          .filter(Boolean)
          .join(" ") || undefined
      );
    }
    default:
      return undefined;
  }
}

/**
 * An approval as a short question in the editor's words: "Edit Lower third?", never a tool
 * identifier or a raw id. Presentation and execution use the same MCP schema, including
 * defaults and stripped extras, so the question names exactly what would run.
 */
export async function toolApproval(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  names?: ToolNames,
): Promise<{
  title: string;
  detail?: string;
  target?: string;
  input: Record<string, unknown>;
}> {
  const { server, name } = parseTool(tool);
  const registered =
    server === CUTROOM_SERVER ? cutroomToolRegistry.get(name) : undefined;
  if (registered) {
    const parsed = safeParse(registered.inputSchema ?? z.object({}), input);
    if (!parsed.success)
      throw new Error(
        `Invalid arguments for ${tool}: ${getParseErrorMessage(parsed.error)}`,
      );
    const args = z.record(z.string(), z.unknown()).parse(parsed.data);
    const target = await toolSubject(tool, args, names);
    const { verb, object } = describeTool({ tool, target }, "ask");
    const detail = approvalDetail(name, args);
    return {
      title: `${verb} ${object}?`,
      ...(detail && { detail }),
      ...(target && { target }),
      input: args,
    };
  }
  const { verb, object } = describeTool({ tool }, "ask");
  // Another server's tool is named with its server, so it cannot pass for one of Cutroom's.
  if (server) return { title: `${verb} ${object} from ${server}?`, input };
  const field = nativeTargets[tool];
  const value = field ? input[field] : undefined;
  if (typeof value !== "string") return { title: `Use ${tool}?`, input };
  const root = cwd.replace(/\/+$/, "");
  const target = value.startsWith(`${root}/`)
    ? value.slice(root.length + 1)
    : value;
  // A command is read in full below the question, not squeezed into it.
  if (runsCommand(tool)) return { title: "Run this command?", target, input };
  return { title: `${verb} ${target}?`, target, input };
}
