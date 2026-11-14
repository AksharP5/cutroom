import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { version } from "../../shared/version";
import {
  AGENT_HEADER,
  AGENT_NAME_HEADER,
  AgentNameSchema,
  reviewReplyGuidance,
} from "../../shared/review";
import { registerReviewTools } from "./reviewTools";
import {
  AnnotationInputSchema,
  AnnotationPatchSchema,
  CreateProjectSchema,
  CutWordsSchema,
  ImportProjectSchema,
  SourceWriteSchema,
  TranscribeInputSchema,
  TranscriptImportSchema,
} from "../../shared/project";
import { MediaRemoveSchema, MediaRenameSchema } from "../../shared/media";
import { EDIT_SUMMARY_HEADER } from "../../shared/timeline/schema";
import type { AnimationFeedback } from "../../shared/timeline/schema";
import { animationEvents } from "./animationFollowup";
import { registerTimelineTools } from "./timelineTools";
import { registerExportTools } from "./exportTools";

type LocalFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response> | Response;
interface McpOptions {
  baseUrl?: string;
  fetch?: LocalFetch;
  /** Set only in the bridge Cutroom gives its native agents; other clients act as `external`. */
  agentToken?: string;
}
const project = {
  projectId: z.string().describe("Project ID returned by projects_list"),
};
const annotation = { ...project, annotationId: z.string() };
const transcript = { ...project, transcriptId: z.string() };

export function localApiBase(raw = "http://127.0.0.1:4317"): string {
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("Cutroom MCP connects only to its local HTTP server.");
  }
  return url.origin;
}

/** Both transports forward to the running server, which alone owns project files and history. */
export function createMcpServer(options: McpOptions = {}) {
  const baseUrl = localApiBase(options.baseUrl);
  const fetchLocal = options.fetch ?? fetch;
  const server = new McpServer(
    { name: "cutroom", version },
    {
      capabilities: { logging: {} },
      instructions:
        "Cutroom is a local video studio. Use project IDs from projects_list. Read existing source before writing and retain its exact version. To create a new composition source file, use source_write with expectedVersion: null; existing paths are refused. Source writes and script edits share the editor's undo history. Script cuts ripple the selected media lane; other tracks retain their timing. Read project annotations for frame, drawing, and time context. Review notes persist until you complete, block, or withdraw them with the review tools; reconcile each new message with the queue first. Never modify source media to cut the timeline. For words on screen with a standard entrance and exit (a lower third, a name, a heading), add a Cutroom title with one timeline_edit insert command whose clip.kind is title; the owner can then edit its words and look, and its motion follows every edit. For bespoke motion, give each animated title or graphic its own sub-composition file: a host clip with data-composition-src, and in that file a timeline in clip-local seconds starting at 0, registered under its composition id. Timeline edits then move, cut and copy it with its animation. Do not put its tweens at absolute seconds on the root timeline. New projects load the pinned GSAP build from assets/vendor/gsap.min.js in index.html, offline in preview and export. Keep that script tag when editing the root composition. Initialize window.__timelines ??= {} before registering a timeline. To end an animation at the clip's end, read the host clip's data-playback-start and data-duration." +
        " " +
        reviewReplyGuidance,
    },
  );
  const toolRegistry = new Map<string, ReturnType<McpServer["registerTool"]>>();
  const registry: Pick<McpServer, "registerTool"> = {
    registerTool: (name, config, callback) => {
      const tool = server.registerTool(name, config, callback);
      toolRegistry.set(name, tool);
      return tool;
    },
  };
  const requestApi = async (
    path: string,
    method = "GET",
    body?: unknown,
    followup?: (data: AnimationFeedback) => Promise<void>,
  ) => {
    try {
      const response = await fetchLocal(`${baseUrl}/api${path}`, {
        method,
        headers: {
          ...(followup && { accept: "text/event-stream" }),
          origin: baseUrl,
          [AGENT_HEADER]: options.agentToken ?? "external",
          [AGENT_NAME_HEADER]: encodeURIComponent(
            AgentNameSchema.parse(
              server.server.getClientVersion()?.name ?? "Agent",
            ),
          ),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      if (response.ok && followup) {
        const events = animationEvents(response);
        const first = await events.next();
        if (first.done || first.value.event !== "result") {
          await events.return();
          throw new Error(
            "Timeline edit did not acknowledge its committed result.",
          );
        }
        const result = first.value.result;
        const summary = response.headers.get(EDIT_SUMMARY_HEADER);
        setTimeout(() => {
          void (async () => {
            for await (const event of events)
              if (
                event.event === "animation-left-behind" &&
                event.feedback.clips.length
              )
                await followup(event.feedback);
          })().catch((error: unknown) =>
            console.error("MCP animation follow-up failed:", error),
          );
        }, 0);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
            // Last, on its own line, where the agent panel reads the row's sentence.
            ...(summary
              ? [
                  {
                    type: "text" as const,
                    text: decodeURIComponent(summary).replace(/\s+/g, " "),
                  },
                ]
              : []),
          ],
          structuredContent: { result },
        };
      }
      const text = await response.text();
      if (!response.ok)
        return {
          content: [
            {
              type: "text" as const,
              text: `Cutroom returned ${response.status}: ${text}`,
            },
          ],
          isError: true,
        };
      const result: unknown = text ? JSON.parse(text) : null;
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        structuredContent: { result },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  };
  const request = (
    path: string,
    method?: string,
    body?: unknown,
    followup?: (data: AnimationFeedback) => Promise<void>,
  ) => requestApi(`/cutroom${path}`, method, body, followup);
  const id = encodeURIComponent;
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };
  const edit = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  };
  registry.registerTool(
    "projects_list",
    {
      description: "List registered local project folders.",
      annotations: readOnly,
    },
    () => request("/projects"),
  );
  registry.registerTool(
    "project_create",
    {
      description: "Create a new local HyperFrames composition.",
      inputSchema: CreateProjectSchema,
      annotations: edit,
    },
    (input) => request("/projects", "POST", input),
  );
  registry.registerTool(
    "project_import",
    {
      description:
        "Register an existing project folder without copying or changing its media.",
      inputSchema: ImportProjectSchema,
      annotations: edit,
    },
    (input) => request("/projects/import", "POST", input),
  );
  registry.registerTool(
    "project_read",
    {
      description: "Read annotations and transcripts for a local project.",
      inputSchema: project,
      annotations: readOnly,
    },
    (input) => request(`/projects/${id(input.projectId)}/document`),
  );
  registry.registerTool(
    "media_list",
    {
      description:
        "List local audio and video clips with source element IDs and timing.",
      inputSchema: project,
      annotations: readOnly,
    },
    (input) => request(`/projects/${id(input.projectId)}/media`),
  );
  registry.registerTool(
    "source_marks",
    {
      description:
        "Read a media file's saved source In/Out marks in seconds, with exclusive Out. Null means unmarked. Marks are project view preferences, outside undo history. To place this range, pass In as clip.mediaStart and convert (Out - In) to timeline frames for clip.duration in timeline_edit. Unmarked ends use 0 and the media duration.",
      inputSchema: {
        ...project,
        path: z.string().describe("Project-relative media file path"),
      },
      annotations: readOnly,
    },
    (input) =>
      request(
        `/projects/${id(input.projectId)}/source-marks?path=${id(input.path)}`,
      ),
  );
  registry.registerTool(
    "media_rename",
    {
      description:
        "Rename a media file in its folder and point every reference in the project's sources at the new name, as one undo step. Keep the file extension. Agent instructions, tool configuration, and hidden files are never rewritten.",
      inputSchema: MediaRenameSchema.extend(project),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`/projects/${id(projectId)}/media/rename`, "POST", input),
  );
  registry.registerTool(
    "media_remove",
    {
      description:
        "Move a media file to the project's trash folder, where it stays recoverable; history_undo moves it back. A file used by clips or composition CSS/scripts is refused with its use count unless confirmUsed is true. Those clips stay on the timeline and play nothing until the file is back.",
      inputSchema: MediaRemoveSchema.extend(project),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`/projects/${id(projectId)}/media/remove`, "POST", input),
  );
  registry.registerTool(
    "source_read",
    {
      description: "Read a project text file and its exact content version.",
      inputSchema: { ...project, path: z.string().default("index.html") },
      annotations: readOnly,
    },
    (input) =>
      request(`/projects/${id(input.projectId)}/source?path=${id(input.path)}`),
  );
  registry.registerTool(
    "source_write",
    {
      description:
        "Save composition source. For existing files pass the exact expectedVersion from source_read; stale writes are refused. Pass expectedVersion: null to create a new file and missing parent folders, without overwriting an existing path. Hidden paths, instructions, tooling configuration, and non-source files are protected.",
      inputSchema: SourceWriteSchema.extend(project),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`/projects/${id(projectId)}/source`, "PUT", input),
  );
  registry.registerTool(
    "annotation_add",
    {
      description:
        "Pin a timed comment or drawing to the composition. Point coordinates are normalized from zero to one.",
      inputSchema: AnnotationInputSchema.extend(project),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`/projects/${id(projectId)}/annotations`, "POST", input),
  );
  registry.registerTool(
    "annotation_update",
    {
      description:
        "Update an unsent note's text, timing, or geometry. Sent notes only change through the review tools.",
      inputSchema: AnnotationPatchSchema.extend(annotation),
      annotations: edit,
    },
    ({ projectId, annotationId, ...input }) =>
      request(
        `/projects/${id(projectId)}/annotations/${id(annotationId)}`,
        "PATCH",
        input,
      ),
  );
  registry.registerTool(
    "annotation_remove",
    {
      description:
        "Remove a note that has not been sent. Withdraw sent notes with review_withdraw instead.",
      inputSchema: annotation,
      annotations: edit,
    },
    ({ projectId, annotationId }) =>
      request(
        `/projects/${id(projectId)}/annotations/${id(annotationId)}`,
        "DELETE",
      ),
  );
  registry.registerTool(
    "transcripts_list",
    {
      description:
        "Read source word timings, cut state, and current timeline positions.",
      inputSchema: project,
      annotations: readOnly,
    },
    (input) => request(`/projects/${id(input.projectId)}/transcripts`),
  );
  registry.registerTool(
    "transcript_import",
    {
      description: "Attach a word-timed transcript to a local media element.",
      inputSchema: TranscriptImportSchema.extend(project),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`/projects/${id(projectId)}/transcripts/import`, "POST", input),
  );
  registry.registerTool(
    "transcript_edit",
    {
      description:
        "Cut or restore selected word IDs. Edits change the timeline source, preserve original media, and are undoable.",
      inputSchema: CutWordsSchema.extend(transcript),
      annotations: edit,
    },
    ({ projectId, transcriptId, ...input }) =>
      request(
        `/projects/${id(projectId)}/transcripts/${id(transcriptId)}/cuts`,
        "POST",
        input,
      ),
  );
  registry.registerTool(
    "transcription_start",
    {
      description:
        "Start local-only Whisper transcription. Requires an already installed runtime and model.",
      inputSchema: TranscribeInputSchema.extend(project),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`/projects/${id(projectId)}/transcribe`, "POST", input),
  );
  registry.registerTool(
    "transcription_status",
    {
      description: "Read the status of a transcription job.",
      inputSchema: { jobId: z.string() },
      annotations: readOnly,
    },
    (input) => request(`/transcription-jobs/${id(input.jobId)}`),
  );
  registry.registerTool(
    "history_list",
    {
      description: "Read the project's shared undo history.",
      inputSchema: project,
      annotations: readOnly,
    },
    (input) => request(`/projects/${id(input.projectId)}/history`),
  );
  registry.registerTool(
    "history_undo",
    {
      description:
        "Undo the most recent project edit through the same history used by the editor.",
      inputSchema: project,
      annotations: edit,
    },
    (input) => request(`/projects/${id(input.projectId)}/history/undo`, "POST"),
  );
  registry.registerTool(
    "history_redo",
    {
      description: "Redo the project's most recently undone edit.",
      inputSchema: project,
      annotations: edit,
    },
    (input) => request(`/projects/${id(input.projectId)}/history/redo`, "POST"),
  );
  registerReviewTools(registry, request);
  registerExportTools(registry, requestApi);
  registerTimelineTools(
    registry,
    request,
    async (path, init) => fetchLocal(`${baseUrl}${path}`, init),
    async (data) => {
      if (!server.isConnected()) return;
      await server.server.sendLoggingMessage({
        level: "warning",
        logger: "cutroom.animation",
        data,
      });
    },
  );
  return Object.assign(server, { toolRegistry });
}

// Allow long gaps between agent calls. A request in flight never counts as idle.
const SESSION_IDLE_MS = 30 * 60 * 1000;
const sessionClock = {
  after(delay: number, run: () => void) {
    const timer = setTimeout(run, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export function createMcpHttpHandler(
  options: McpOptions = {},
  clock = sessionClock,
) {
  const sessions = new Map<
    string,
    {
      server: ReturnType<typeof createMcpServer>;
      transport: WebStandardStreamableHTTPServerTransport;
      active: number;
      cancelExpiry(): void;
    }
  >();
  const handler = async (request: Request): Promise<Response> => {
    const id = request.headers.get("mcp-session-id");
    let session = id ? sessions.get(id) : undefined;
    if (id && !session)
      return new Response("MCP session not found.", { status: 404 });
    if (!session) {
      const server = createMcpServer(options);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, created);
        },
      });
      const created = { server, transport, active: 0, cancelExpiry: () => {} };
      transport.onclose = () => {
        created.cancelExpiry();
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      session = created;
    }
    const current = session;
    current.cancelExpiry();
    current.active++;
    try {
      const response = await current.transport.handleRequest(request);
      if (!current.transport.sessionId || request.method === "DELETE")
        await current.server.close();
      return response;
    } finally {
      current.active--;
      if (
        !current.active &&
        sessions.get(current.transport.sessionId ?? "") === current
      ) {
        current.cancelExpiry = clock.after(SESSION_IDLE_MS, () => {
          void current.server
            .close()
            .catch((error: unknown) =>
              console.error("MCP session expiry failed:", error),
            );
        });
      }
    }
  };
  return Object.assign(handler, {
    dispose: () =>
      Promise.all([...sessions.values()].map(({ server }) => server.close())),
  });
}
