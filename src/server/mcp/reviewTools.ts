import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ReviewAddSchema, reviewActions } from "../../shared/review";

type LocalRequest = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<CallToolResult>;

const project = {
  projectId: z.string().describe("Project ID from the review digest"),
};
const note = { ...project, noteId: z.string().describe("Review note ID") };
const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/** The agent's side of the review queue. Accept, reject, restore, and reorder stay with the owner. */
export function registerReviewTools(server: McpServer, request: LocalRequest) {
  const id = encodeURIComponent;
  const act = (projectId: string, noteId: string, action: object) =>
    request(
      `/projects/${id(projectId)}/review/${id(noteId)}/agent`,
      "POST",
      action,
    );
  server.registerTool(
    "review_list",
    {
      description:
        "Read every review note in the owner's order with its status, the owner's added instructions, geometry, and frame.",
      inputSchema: project,
      annotations: { ...annotations, readOnlyHint: true },
    },
    (input) => request(`/projects/${id(input.projectId)}/review`),
  );
  server.registerTool(
    "review_add",
    {
      description:
        "Add a queued request, such as the replacement for a withdrawn note.",
      inputSchema: ReviewAddSchema.extend(project),
      annotations,
    },
    ({ projectId, ...input }) =>
      request(`/projects/${id(projectId)}/review`, "POST", input),
  );
  server.registerTool(
    "review_claim",
    {
      description:
        "Start work on a new or queued note, or on a blocked note the owner's message answered. It returns to the queue if this run ends first.",
      inputSchema: note,
      annotations,
    },
    ({ projectId, noteId }) => act(projectId, noteId, { type: "claim" }),
  );
  server.registerTool(
    "review_complete",
    {
      description:
        "Mark a note done with a short note on what changed. The latest history entry is recorded unless you pass one. The owner then accepts or rejects it.",
      inputSchema: reviewActions.complete.omit({ type: true }).extend(note),
      annotations,
    },
    ({ projectId, noteId, ...input }) =>
      act(projectId, noteId, { type: "complete", ...input }),
  );
  server.registerTool(
    "review_block",
    {
      description:
        "Pause a note until the owner answers a question. Their reply returns it to the queue.",
      inputSchema: reviewActions.block.omit({ type: true }).extend(note),
      annotations,
    },
    ({ projectId, noteId, question }) =>
      act(projectId, noteId, { type: "block", question }),
  );
  server.registerTool(
    "review_withdraw",
    {
      description:
        "Withdraw a note, including a finished one, that the owner's newer message cancels or replaces, with the reason shown to them. The owner can restore it.",
      inputSchema: reviewActions.withdraw.omit({ type: true }).extend(note),
      annotations,
    },
    ({ projectId, noteId, ...input }) =>
      act(projectId, noteId, { type: "withdraw", ...input }),
  );
}
