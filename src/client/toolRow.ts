import type { AgentMessage } from "../shared/agent";

type Verb = readonly [done: string, active: string];

const nativeTools: Record<string, Verb> = {
  read: ["Read", "Reading"],
  edit: ["Edited", "Editing"],
  multiedit: ["Edited", "Editing"],
  write: ["Wrote", "Writing"],
  notebookedit: ["Edited", "Editing"],
  files: ["Edited", "Editing"],
  bash: ["Ran", "Running"],
  shell: ["Ran", "Running"],
  grep: ["Searched", "Searching"],
  glob: ["Searched", "Searching"],
  webfetch: ["Fetched", "Fetching"],
  websearch: ["Searched the web", "Searching the web"],
  task: ["Delegated", "Delegating"],
  agent: ["Delegated", "Delegating"],
  todowrite: ["Planned", "Planning"],
};

/** MCP tools are named `<object>_<verb>`, as in `timeline_read` or `review_claim`. */
const toolVerbs: Record<string, Verb> = {
  read: ["Read", "Reading"],
  write: ["Wrote", "Writing"],
  edit: ["Edited", "Editing"],
  view: ["Viewed", "Viewing"],
  list: ["Listed", "Listing"],
  add: ["Added", "Adding"],
  remove: ["Removed", "Removing"],
  update: ["Updated", "Updating"],
  create: ["Created", "Creating"],
  import: ["Imported", "Importing"],
  start: ["Started", "Starting"],
  status: ["Checked", "Checking"],
  claim: ["Claimed", "Claiming"],
  complete: ["Completed", "Completing"],
  block: ["Asked about", "Asking about"],
  release: ["Released", "Releasing"],
  withdraw: ["Withdrew", "Withdrawing"],
  accept: ["Accepted", "Accepting"],
  reply: ["Answered", "Answering"],
  restore: ["Restored", "Restoring"],
  undo: ["Undid", "Undoing"],
  redo: ["Redid", "Redoing"],
};

/** One line for a tool call: a verb, its object, and whether it is still running. */
export function describeTool({
  tool = "Tool",
  target,
  status,
}: Pick<AgentMessage, "tool" | "target" | "status">) {
  const active = status === "streaming";
  const name = tool.split(/__|: /).at(-1) ?? tool;
  const native = nativeTools[name.toLowerCase()];
  if (native) return { verb: native[active ? 1 : 0], object: target ?? "" };
  const words = name.split(/[_-]+/).filter(Boolean);
  const verb = toolVerbs[words.at(-1)?.toLowerCase() ?? ""];
  const subject = (verb ? words.slice(0, -1) : words).join(" ");
  const object = [subject, target].filter(Boolean).join(" ");
  if (verb) return { verb: verb[active ? 1 : 0], object };
  return { verb: active ? "Using" : "Used", object };
}
