import {
  safeParse,
  getParseErrorMessage,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import { describeTool } from "../../shared/toolRow";
import { cutroomToolRegistry } from "./tool-permissions";

// These are the fields each registered tool actually consumes as its target.
const targets: Record<string, string> = {
  project_create: "name",
  project_import: "path",
  source_read: "path",
  source_write: "path",
  annotation_add: "compositionPath",
  annotation_update: "annotationId",
  annotation_remove: "annotationId",
  transcript_import: "mediaPath",
  transcript_edit: "transcriptId",
  transcription_start: "mediaPath",
  transcription_status: "jobId",
  timeline_read: "composition",
  timeline_edit: "composition",
  timeline_view: "composition",
  review_add: "compositionPath",
  review_claim: "noteId",
  review_complete: "noteId",
  review_block: "noteId",
  review_withdraw: "noteId",
  review_accept: "noteId",
  review_send_back: "noteId",
  review_reply: "noteId",
  review_restore: "noteId",
  review_release: "noteId",
  review_reorder: "noteId",
};
const nativeTargets: Record<string, string> = {
  Bash: "command",
  Shell: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** Presentation and execution use the same MCP schema, including defaults and stripped extras. */
export function toolApproval(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
) {
  const prefix = "mcp__cutroom_studio__";
  const name = tool.startsWith(prefix) ? tool.slice(prefix.length) : undefined;
  const registered =
    name === undefined ? undefined : cutroomToolRegistry.get(name);
  let args = input;
  if (registered) {
    const parsed = safeParse(registered.inputSchema ?? z.object({}), input);
    if (!parsed.success)
      throw new Error(
        `Invalid arguments for ${tool}: ${getParseErrorMessage(parsed.error)}`,
      );
    args = z.record(z.string(), z.unknown()).parse(parsed.data);
  }
  const field = registered && name ? targets[name] : nativeTargets[tool];
  const value = field ? args[field] : undefined;
  const root = cwd.replace(/\/+$/, "");
  const target =
    typeof value === "string"
      ? registered || !value.startsWith(`${root}/`)
        ? value
        : value.slice(root.length + 1)
      : undefined;
  if (!registered && !field) return { title: `Use ${tool}?`, input: args };
  const separateTarget =
    registered &&
    name &&
    (name.startsWith("timeline_") || name.startsWith("review_"));
  const { verb, object } = describeTool(
    { tool, target: separateTarget ? undefined : target },
    "ask",
  );
  const extraTarget = separateTarget && target ? ` (${target})` : "";
  const count =
    name === "timeline_edit" && Array.isArray(args.commands)
      ? ` (${args.commands.length} ${args.commands.length === 1 ? "change" : "changes"})`
      : "";
  return {
    title: `${verb} ${object}${extraTarget}${count}?`,
    target,
    input: args,
  };
}
