import type { AgentMessage } from "./agent";

/** How a tool call reads once done, while running, and when asking permission. */
type Verb = readonly [done: string, active: string, ask: string];
type Mode = "done" | "active" | "ask";
const form = { done: 0, active: 1, ask: 2 } as const;

const nativeTools: Record<string, Verb> = {
  read: ["Read", "Reading", "Read"],
  edit: ["Edited", "Editing", "Edit"],
  multiedit: ["Edited", "Editing", "Edit"],
  write: ["Wrote", "Writing", "Write"],
  notebookedit: ["Edited", "Editing", "Edit"],
  files: ["Edited", "Editing", "Edit"],
  bash: ["Ran", "Running", "Run"],
  shell: ["Ran", "Running", "Run"],
  grep: ["Searched", "Searching", "Search"],
  glob: ["Searched", "Searching", "Search"],
  webfetch: ["Fetched", "Fetching", "Fetch"],
  websearch: ["Searched the web", "Searching the web", "Search the web"],
  task: ["Delegated", "Delegating", "Delegate"],
  agent: ["Delegated", "Delegating", "Delegate"],
  todowrite: ["Planned", "Planning", "Plan"],
};

/** Tools whose target is a file path, so a long one keeps its file name. */
const fileTools = new Set([
  "read",
  "edit",
  "multiedit",
  "write",
  "notebookedit",
  "files",
  "source_read",
  "source_write",
]);

/** Cutroom's own MCP tools, named for what they do to the project. */
const cutroomTools: Record<
  string,
  { verb: Verb; object: (target?: string) => string }
> = {
  source_read: {
    verb: ["Read", "Reading", "Read"],
    object: (target = "index.html") => target,
  },
  source_write: {
    verb: ["Edited", "Editing", "Write"],
    object: (target = "index.html") => target,
  },
  timeline_read: {
    verb: ["Read", "Reading", "Read"],
    object: () => "the timeline",
  },
  timeline_edit: {
    verb: ["Edited", "Editing", "Edit"],
    object: () => "the timeline",
  },
  timeline_view: {
    verb: ["Rendered", "Rendering", "Render"],
    object: () => "a check frame",
  },
  review_list: {
    verb: ["Read", "Reading", "Read"],
    object: () => "the review queue",
  },
  review_add: { verb: ["Added", "Adding", "Add"], object: () => "a note" },
  review_claim: {
    verb: ["Started", "Starting", "Start"],
    object: () => "a note",
  },
  review_complete: {
    verb: ["Finished", "Finishing", "Finish"],
    object: () => "a note",
  },
  review_block: {
    verb: ["Asked about", "Asking about", "Ask about"],
    object: () => "a note",
  },
  review_withdraw: {
    verb: ["Withdrew", "Withdrawing", "Withdraw"],
    object: () => "a note",
  },
  media_list: {
    verb: ["Listed", "Listing", "List"],
    object: () => "project media",
  },
  history_undo: {
    verb: ["Undid", "Undoing", "Undo"],
    object: () => "the last edit",
  },
  history_redo: {
    verb: ["Redid", "Redoing", "Redo"],
    object: () => "an edit",
  },
};

/** Other MCP tools are named `<object>_<verb>`, as in `transcripts_list`. */
const toolVerbs: Record<string, Verb> = {
  read: ["Read", "Reading", "Read"],
  write: ["Wrote", "Writing", "Write"],
  edit: ["Edited", "Editing", "Edit"],
  view: ["Viewed", "Viewing", "View"],
  list: ["Listed", "Listing", "List"],
  add: ["Added", "Adding", "Add"],
  remove: ["Removed", "Removing", "Remove"],
  update: ["Updated", "Updating", "Update"],
  create: ["Created", "Creating", "Create"],
  import: ["Imported", "Importing", "Import"],
  start: ["Started", "Starting", "Start"],
  status: ["Checked", "Checking", "Check"],
};

/** Plumbing the agent uses to find its tools; never shown as a row. */
export const hiddenTools = new Set(["ToolSearch"]);

/** Whether a tool call's target is a file, which should truncate from its start. */
export function targetsFile(tool = "") {
  return fileTools.has((tool.split(/__|: /).at(-1) ?? tool).toLowerCase());
}

/** One line for a tool call: a verb and what it acted on. */
export function describeTool(
  { tool = "Tool", target }: Pick<AgentMessage, "tool" | "target">,
  mode: Mode = "done",
) {
  const pick = (verb: Verb) => verb[form[mode]];
  const name = tool.split(/__|: /).at(-1) ?? tool;
  const own = cutroomTools[name];
  if (own) return { verb: pick(own.verb), object: own.object(target) };
  const native = nativeTools[name.toLowerCase()];
  if (native) return { verb: pick(native), object: target ?? "" };
  const words = name.split(/[_-]+/).filter(Boolean);
  const verb = toolVerbs[words.at(-1)?.toLowerCase() ?? ""];
  const subject = (verb ? words.slice(0, -1) : words).join(" ");
  const object = [subject, target].filter(Boolean).join(" ");
  if (verb) return { verb: pick(verb), object };
  return { verb: pick(["Used", "Using", "Use"]), object };
}
