import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { version } from "../../shared/version";
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

type LocalFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response> | Response;
interface McpOptions {
  baseUrl?: string;
  fetch?: LocalFetch;
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
      instructions:
        "Cutroom is a local video studio. Use project IDs from projects_list. Read source before writing and retain its exact version. Source writes and script edits share the editor's undo history. Script cuts ripple the selected media lane; other tracks retain their timing. Read project annotations for frame, drawing, and time context. Review notes persist until you complete, block, or withdraw them with the review tools; reconcile each new message with the queue first. Never modify source media to cut the timeline.",
    },
  );
  const request = async (path: string, method = "GET", body?: unknown) => {
    try {
      const response = await fetchLocal(`${baseUrl}/api/cutroom${path}`, {
        method,
        ...(body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
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
  server.registerTool(
    "projects_list",
    {
      description: "List registered local project folders.",
      annotations: readOnly,
    },
    () => request("/projects"),
  );
  server.registerTool(
    "project_create",
    {
      description: "Create a new local HyperFrames composition.",
      inputSchema: CreateProjectSchema,
      annotations: edit,
    },
    (input) => request("/projects", "POST", input),
  );
  server.registerTool(
    "project_import",
    {
      description:
        "Register an existing project folder without copying or changing its media.",
      inputSchema: ImportProjectSchema,
      annotations: edit,
    },
    (input) => request("/projects/import", "POST", input),
  );
  server.registerTool(
    "project_read",
    {
      description: "Read annotations and transcripts for a local project.",
      inputSchema: project,
      annotations: readOnly,
    },
    (input) => request(`/projects/${id(input.projectId)}/document`),
  );
  server.registerTool(
    "media_list",
    {
      description:
        "List local audio and video clips with source element IDs and timing.",
      inputSchema: project,
      annotations: readOnly,
    },
    (input) => request(`/projects/${id(input.projectId)}/media`),
  );
  server.registerTool(
    "source_read",
    {
      description: "Read a project text file and its exact content version.",
      inputSchema: { ...project, path: z.string().default("index.html") },
      annotations: readOnly,
    },
    (input) =>
      request(`/projects/${id(input.projectId)}/source?path=${id(input.path)}`),
  );
  server.registerTool(
    "source_write",
    {
      description:
        "Save a project text file. The exact expectedVersion from source_read is required; stale writes are refused.",
      inputSchema: SourceWriteSchema.extend(project),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`/projects/${id(projectId)}/source`, "PUT", input),
  );
  server.registerTool(
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
  server.registerTool(
    "annotation_update",
    {
      description:
        "Update an annotation's note, timing, or geometry. Use the review tools to change its status.",
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
  server.registerTool(
    "annotation_remove",
    {
      description:
        "Remove a note that has not been sent. Withdraw submitted notes with review_withdraw instead.",
      inputSchema: annotation,
      annotations: edit,
    },
    ({ projectId, annotationId }) =>
      request(
        `/projects/${id(projectId)}/annotations/${id(annotationId)}`,
        "DELETE",
      ),
  );
  server.registerTool(
    "transcripts_list",
    {
      description:
        "Read source word timings, cut state, and current timeline positions.",
      inputSchema: project,
      annotations: readOnly,
    },
    (input) => request(`/projects/${id(input.projectId)}/transcripts`),
  );
  server.registerTool(
    "transcript_import",
    {
      description: "Attach a word-timed transcript to a local media element.",
      inputSchema: TranscriptImportSchema.extend(project),
      annotations: edit,
    },
    ({ projectId, ...input }) =>
      request(`/projects/${id(projectId)}/transcripts/import`, "POST", input),
  );
  server.registerTool(
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
  server.registerTool(
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
  server.registerTool(
    "transcription_status",
    {
      description: "Read the status of a transcription job.",
      inputSchema: { jobId: z.string() },
      annotations: readOnly,
    },
    (input) => request(`/transcription-jobs/${id(input.jobId)}`),
  );
  server.registerTool(
    "history_list",
    {
      description: "Read the project's shared undo history.",
      inputSchema: project,
      annotations: readOnly,
    },
    (input) => request(`/projects/${id(input.projectId)}/history`),
  );
  server.registerTool(
    "history_undo",
    {
      description:
        "Undo the most recent project edit through the same history used by the editor.",
      inputSchema: project,
      annotations: edit,
    },
    (input) => request(`/projects/${id(input.projectId)}/history/undo`, "POST"),
  );
  server.registerTool(
    "history_redo",
    {
      description: "Redo the project's most recently undone edit.",
      inputSchema: project,
      annotations: edit,
    },
    (input) => request(`/projects/${id(input.projectId)}/history/redo`, "POST"),
  );
  registerReviewTools(server, request);
  return server;
}

export function createMcpHttpHandler(options: McpOptions = {}) {
  return async (request: Request): Promise<Response> => {
    const server = createMcpServer(options);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      const body = response.body ? await response.arrayBuffer() : null;
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      await server.close();
    }
  };
}
