import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CaptionsEditSchema,
  SubtitleFormatSchema,
  SubtitleImportSchema,
} from "../../shared/captions";

export function registerCaptionTools(
  server: Pick<McpServer, "registerTool">,
  request: (
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<CallToolResult>,
) {
  const projectId = z.string().describe("Project ID returned by projects_list");
  const project = (id: string) => `/projects/${encodeURIComponent(id)}`;
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
    "captions_list",
    {
      description:
        "List each transcript's captions: the captions clip and file, style, lines in composition seconds, words whose caption text differs from the transcript, and stale, which is true when the transcript's clip changed since the captions were written.",
      inputSchema: { projectId },
      annotations: readOnly,
    },
    (input) => request(`${project(input.projectId)}/captions`),
  );
  server.registerTool(
    "captions_edit",
    {
      description:
        "Add, regenerate, restyle or correct a transcript's captions, as one undo step. generate writes compositions/captions.html, a HyperFrames sub-composition of timed lines in the caption safe area, and places it as one clip on a new Captions track; on captions that exist it rewrites them to follow the transcript's words where they now play, after timeline edits such as razors, ripple deletes or moves of the footage. Script cuts with transcript_edit update captions by themselves. Restyling and word edits keep timing. Regenerating replaces hand edits to the captions file and resets the captions clip's start and length on the timeline, but keeps word corrections and its look in the inspector.",
      inputSchema: { projectId, edit: CaptionsEditSchema },
      annotations: edit,
    },
    (input) =>
      request(`${project(input.projectId)}/captions`, "POST", input.edit),
  );
  server.registerTool(
    "captions_export",
    {
      description:
        "Export a transcript's captions as SRT or WebVTT text, one cue per caption line, timed in the seconds of the composition the captions play in. Returns {format, filename, text}; save the text where the owner asks.",
      inputSchema: {
        projectId,
        transcriptId: z
          .string()
          .describe("Transcript ID from transcripts_list"),
        format: SubtitleFormatSchema,
      },
      annotations: readOnly,
    },
    (input) =>
      request(
        `${project(input.projectId)}/captions/${encodeURIComponent(input.transcriptId)}/export?format=${input.format}`,
      ),
  );
  server.registerTool(
    "subtitles_import",
    {
      description:
        "Attach an SRT or WebVTT file to a local media element as its transcript, as transcript_import does for word timings. Cue times are seconds into the media file. Each cue's words share its time by length, so script cuts and captions work at word level. Styling tags are dropped. Files are limited to 2 MB, 20,000 cues and 24 hours.",
      inputSchema: SubtitleImportSchema.extend({ projectId }),
      annotations: edit,
    },
    ({ projectId: id, ...input }) =>
      request(`${project(id)}/transcripts/subtitles`, "POST", input),
  );
}
