import type { AgentMessage } from "./agent";

/** How a tool call reads once done, while running, and when asking permission. */
type Verb = readonly [done: string, active: string, ask: string];
type Mode = "done" | "active" | "ask";
const form = { done: 0, active: 1, ask: 2 } as const;

/**
 * The kinds of routine step a summary folds into counts, in the order it names them: the work
 * first, the project and queue lookups around it last.
 */
const foldedKinds = [
  "file",
  "command",
  "search",
  "frame",
  "web",
  "other",
  "project",
  "queue",
] as const;
type FoldedKind = (typeof foldedKinds)[number];
/** What a step did. An `edit` changed the project and always keeps its own row. */
type StepKind = FoldedKind | "edit";
type Tool = { verb: Verb; kind: StepKind };

const read: Verb = ["Read", "Reading", "Read"];
const edited: Verb = ["Edited", "Editing", "Edit"];
const ran: Verb = ["Ran", "Running", "Run"];
const searched: Verb = ["Searched", "Searching", "Search"];
const delegated: Verb = ["Delegated", "Delegating", "Delegate"];

const nativeTools: Record<string, Tool> = {
  read: { verb: read, kind: "file" },
  edit: { verb: edited, kind: "edit" },
  multiedit: { verb: edited, kind: "edit" },
  write: { verb: ["Wrote", "Writing", "Write"], kind: "edit" },
  notebookedit: { verb: edited, kind: "edit" },
  files: { verb: edited, kind: "edit" },
  bash: { verb: ran, kind: "command" },
  shell: { verb: ran, kind: "command" },
  grep: { verb: searched, kind: "search" },
  glob: { verb: searched, kind: "search" },
  webfetch: { verb: ["Fetched", "Fetching", "Fetch"], kind: "web" },
  websearch: {
    verb: ["Searched the web", "Searching the web", "Search the web"],
    kind: "web",
  },
  task: { verb: delegated, kind: "other" },
  agent: { verb: delegated, kind: "other" },
  todowrite: { verb: ["Planned", "Planning", "Plan"], kind: "other" },
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

/** Cutroom's MCP server, as Claude (`mcp__cutroom_studio__x`) and Codex (`cutroom_studio: x`) name it. */
export const CUTROOM_SERVER = "cutroom_studio";

const note = (target?: string) => target ?? "a note";
const file = (target = "index.html") => target;
/**
 * Cutroom's own MCP tools, named for what they do to the project. A target is the name the
 * editor shows: a file, the clips an edit touches, or a note's first words.
 */
const cutroomTools: Record<
  string,
  Tool & { object: (target?: string) => string }
> = {
  projects_list: {
    verb: ["Listed", "Listing", "List"],
    kind: "project",
    object: () => "projects",
  },
  project_create: {
    verb: ["Created", "Creating", "Create"],
    kind: "edit",
    object: (target) => (target ? `project ${target}` : "a project"),
  },
  project_import: {
    verb: ["Imported", "Importing", "Import"],
    kind: "edit",
    object: (target) => target ?? "a project folder",
  },
  project_read: { verb: read, kind: "project", object: () => "the project" },
  media_list: {
    verb: ["Listed", "Listing", "List"],
    kind: "project",
    object: () => "project media",
  },
  media_rename: {
    verb: ["Renamed", "Renaming", "Rename"],
    kind: "edit",
    object: (target) => target ?? "a media file",
  },
  media_remove: {
    verb: ["Removed", "Removing", "Remove"],
    kind: "edit",
    object: (target) => target ?? "a media file",
  },
  source_read: { verb: read, kind: "file", object: file },
  source_write: {
    verb: ["Edited", "Editing", "Write"],
    kind: "edit",
    object: file,
  },
  annotation_add: {
    verb: ["Added", "Adding", "Add"],
    kind: "queue",
    object: () => "a note",
  },
  annotation_update: {
    verb: ["Updated", "Updating", "Update"],
    kind: "queue",
    object: note,
  },
  annotation_remove: {
    verb: ["Removed", "Removing", "Remove"],
    kind: "queue",
    object: note,
  },
  transcripts_list: { verb: read, kind: "project", object: () => "the script" },
  transcript_import: {
    verb: ["Imported", "Importing", "Import"],
    kind: "edit",
    object: (target) =>
      target ? `a transcript for ${target}` : "a transcript",
  },
  transcript_edit: {
    verb: edited,
    kind: "edit",
    object: (target) => (target ? `the script of ${target}` : "the script"),
  },
  transcription_start: {
    verb: ["Transcribed", "Transcribing", "Transcribe"],
    kind: "edit",
    object: (target) => target ?? "media",
  },
  transcription_status: {
    verb: ["Checked", "Checking", "Check"],
    kind: "project",
    object: () => "the transcription",
  },
  history_list: { verb: read, kind: "project", object: () => "the history" },
  history_undo: {
    verb: ["Undid", "Undoing", "Undo"],
    kind: "edit",
    object: () => "the last edit",
  },
  history_redo: {
    verb: ["Redid", "Redoing", "Redo"],
    kind: "edit",
    object: () => "an edit",
  },
  source_marks: { verb: read, kind: "project", object: () => "source marks" },
  timeline_read: { verb: read, kind: "project", object: () => "the timeline" },
  timeline_edit: {
    verb: edited,
    kind: "edit",
    object: (target) => target ?? "the timeline",
  },
  timeline_destinations: {
    verb: ["Checked", "Checking", "Check"],
    kind: "project",
    object: () => "the destination tracks",
  },
  timeline_copy: {
    verb: ["Copied", "Copying", "Copy"],
    kind: "project",
    object: () => "clips",
  },
  timeline_view: {
    verb: ["Rendered", "Rendering", "Render"],
    kind: "frame",
    object: () => "a check frame",
  },
  review_list: {
    verb: read,
    kind: "project",
    object: () => "the review queue",
  },
  review_add: {
    verb: ["Added", "Adding", "Add"],
    kind: "queue",
    object: () => "a note",
  },
  review_claim: {
    verb: ["Started", "Starting", "Start"],
    kind: "queue",
    object: note,
  },
  review_complete: {
    verb: ["Finished", "Finishing", "Finish"],
    kind: "queue",
    object: note,
  },
  review_block: {
    verb: ["Asked about", "Asking about", "Ask about"],
    kind: "queue",
    object: note,
  },
  review_withdraw: {
    verb: ["Withdrew", "Withdrawing", "Withdraw"],
    kind: "queue",
    object: note,
  },
  review_release: {
    verb: ["Returned", "Returning", "Return"],
    kind: "queue",
    object: (target) => `${note(target)} to the queue`,
  },
  review_reorder: {
    verb: ["Moved", "Moving", "Move"],
    kind: "queue",
    object: note,
  },
  review_accept: {
    verb: ["Accepted", "Accepting", "Accept"],
    kind: "queue",
    object: note,
  },
  review_send_back: {
    verb: ["Sent back", "Sending back", "Send back"],
    kind: "queue",
    object: note,
  },
  review_reply: {
    verb: ["Answered", "Answering", "Answer"],
    kind: "queue",
    object: note,
  },
  review_restore: {
    verb: ["Restored", "Restoring", "Restore"],
    kind: "queue",
    object: note,
  },
  export_start: {
    verb: ["Started", "Starting", "Start"],
    kind: "edit",
    object: () => "an export",
  },
  export_status: {
    verb: ["Checked", "Checking", "Check"],
    kind: "project",
    object: () => "the export",
  },
  export_cancel: {
    verb: ["Cancelled", "Cancelling", "Cancel"],
    kind: "edit",
    object: () => "the export",
  },
};
/** Every Cutroom tool that has its own wording, so a new tool cannot ship without one. */
export const describedCutroomTools = Object.keys(cutroomTools);

/** Other MCP tools are named `<object>_<verb>`, as in `issues_list`. */
const toolVerbs: Record<string, Verb> = {
  read,
  write: ["Wrote", "Writing", "Write"],
  edit: edited,
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

/** An MCP tool's server and bare name, in either agent's spelling; a native tool has no server. */
export function parseTool(tool: string) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool) ?? /^([^:]+): (.+)$/.exec(tool);
  return mcp ? { server: mcp[1], name: mcp[2] ?? tool } : { name: tool };
}

/** Whether a tool call's target is a file, which should truncate from its start. */
export function targetsFile(tool = "") {
  return fileTools.has(parseTool(tool).name.toLowerCase());
}

function lookup(tool: string) {
  const { server, name } = parseTool(tool);
  // Another server's `timeline_edit` is not Cutroom's and never borrows its wording.
  const own = server === CUTROOM_SERVER ? cutroomTools[name] : undefined;
  const native = server ? undefined : nativeTools[name.toLowerCase()];
  return { server, name, own, native };
}

function stepKind(tool = ""): StepKind {
  const { own, native } = lookup(tool);
  return own?.kind ?? native?.kind ?? "other";
}

/** Whether a tool call runs a shell command, whose target is the command line itself. */
export const runsCommand = (tool = "") => stepKind(tool) === "command";

/** Whether a tool call changes the project, so its row is never folded away. */
export const editsProject = (tool = "") => stepKind(tool) === "edit";

/** One line for a tool call: a verb and what it acted on. */
export function describeTool(
  {
    tool = "Tool",
    target,
    summary,
  }: Pick<AgentMessage, "tool" | "target" | "summary">,
  mode: Mode = "done",
) {
  const pick = (verb: Verb) => verb[form[mode]];
  const { name, own, native } = lookup(tool);
  // A saved edit reads as its own sentence: "Extended still.png by 1 s".
  const [, did, what] = /^(\S+)\s+(.+)$/s.exec(summary ?? "") ?? [];
  if (mode === "done" && did && what) return { verb: did, object: what };
  if (own) return { verb: pick(own.verb), object: own.object(target) };
  if (native) return { verb: pick(native.verb), object: target ?? "" };
  const words = name.split(/[_-]+/).filter(Boolean);
  const verb = toolVerbs[words.at(-1)?.toLowerCase() ?? ""];
  const subject = (verb ? words.slice(0, -1) : words).join(" ");
  const object = [subject, target].filter(Boolean).join(" ");
  if (verb) return { verb: pick(verb), object };
  return { verb: pick(["Used", "Using", "Use"]), object };
}

const count = (total: number, one: string) =>
  `${total} ${total === 1 ? one : `${one}s`}`;
/** How each folded kind reads in a summary, once done and while one of its steps is running. */
const tallies: Record<FoldedKind, (total: number, running: boolean) => string> =
  {
    file: (total, running) =>
      `${running ? "reading" : "read"} ${count(total, "file")}`,
    command: (total, running) =>
      `${running ? "running" : "ran"} ${count(total, "command")}`,
    search: (total, running) =>
      `${running ? "searching" : "searched"} ${count(total, "time")}`,
    frame: (total, running) =>
      `${running ? "rendering" : "rendered"} ${count(total, "frame")}`,
    web: (_total, running) => `${running ? "browsing" : "browsed"} the web`,
    other: (total, running) =>
      `${running ? "using" : "used"} ${count(total, "tool")}`,
    project: (_total, running) =>
      `${running ? "checking" : "checked"} the project`,
    queue: (_total, running) =>
      `${running ? "updating" : "updated"} the review queue`,
  };
/** A summary names this many kinds and counts the rest, so it stays on one line as a turn grows. */
const NAMED_KINDS = 2;

/**
 * One turn segment's tool calls as a step group. Routine steps fold into a summary such as
 * "Read 6 files, ran 3 commands, 2 more"; failures and project edits stay visible as rows.
 * A lone routine step needs no summary and shows as its row.
 */
export function summarizeSteps(
  steps: readonly AgentMessage[],
  grouped = false,
) {
  const shown: AgentMessage[] = [];
  const folded: AgentMessage[] = [];
  for (const step of steps)
    (step.status === "failed" || editsProject(step.tool) ? shown : folded).push(
      step,
    );
  if (folded.length < 2 && !grouped)
    return { summary: "", running: false, shown: [...steps] };
  const present = foldedKinds.flatMap((kind) => {
    const of = folded.filter((step) => stepKind(step.tool) === kind);
    return of.length
      ? [
          {
            total: of.length,
            text: tallies[kind](
              of.length,
              of.some((step) => step.status === "streaming"),
            ),
          },
        ]
      : [];
  });
  const rest = present
    .slice(NAMED_KINDS)
    .reduce((sum, kind) => sum + kind.total, 0);
  const text =
    [
      ...present.slice(0, NAMED_KINDS).map((kind) => kind.text),
      ...(rest ? [`${rest} more`] : []),
    ].join(", ") || count(steps.length, "step");
  return {
    summary: text.charAt(0).toUpperCase() + text.slice(1),
    running: folded.some((step) => step.status === "streaming"),
    shown,
  };
}

/** Tool results arrive as text, or as MCP content blocks serialized to JSON. */
function resultText(text: string) {
  if (!/^\s*[[{]/.test(text)) return text;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  const blocks: unknown =
    value && typeof value === "object" && "content" in value
      ? value.content
      : value;
  if (!Array.isArray(blocks)) return text;
  const parts = blocks.flatMap((block: unknown) =>
    block &&
    typeof block === "object" &&
    "text" in block &&
    typeof block.text === "string"
      ? [block.text]
      : [],
  );
  return parts.length ? parts.join("\n") : text;
}

/** What a timeline edit did: the sentence Cutroom's MCP server ends the call's result with. */
export function editSummary(tool = "", text: string) {
  const { server, name } = parseTool(tool);
  if (server !== CUTROOM_SERVER || name !== "timeline_edit") return undefined;
  const last = resultText(text).trimEnd().split("\n").at(-1)?.trim();
  // Without a sentence the result ends with the view's closing brace.
  return last && !/^[\]}]/.test(last) ? last : undefined;
}

/** The line of a failed call's output that says what went wrong, shown without opening the row. */
export function failureReason({
  tool,
  text,
}: Pick<AgentMessage, "tool" | "text">) {
  const lines = resultText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // Codex leads a command's output with the command, and Claude with its exit code.
  if (tool === "Shell" && lines.length > 1) lines.shift();
  const line =
    lines.find((candidate) => !/^exit code \d+$/i.test(candidate)) ?? "";
  // Cutroom's API answers a refused call with `{"error": "why"}`.
  const refused = /^Cutroom returned \d+: (\{.*\})$/.exec(line);
  if (refused?.[1])
    try {
      const body: unknown = JSON.parse(refused[1]);
      if (
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
      )
        return body.error;
    } catch {
      /* Not JSON after all; the line itself is the reason. */
    }
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}
