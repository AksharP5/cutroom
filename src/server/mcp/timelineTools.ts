import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AnimationFeedback } from "../../shared/timeline/schema";
import { frameTime } from "../../shared/timeline/apply";
import {
  CommandBatchSchema,
  CopyClipsSchema,
  TimelineViewSchema,
} from "../../shared/timeline/schema";

type JsonRequest = (
  path: string,
  method?: string,
  body?: unknown,
  followup?: (data: AnimationFeedback) => Promise<void>,
) => Promise<CallToolResult>;
/** Fetches a path on the local server, such as `/api/projects/...`. */
type LocalFetch = (path: string, init?: RequestInit) => Promise<Response>;

const input = {
  projectId: z.string().describe("Project ID returned by projects_list"),
  composition: z
    .string()
    .default("index.html")
    .describe("Composition file within the project"),
};
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

export function registerTimelineTools(
  server: Pick<McpServer, "registerTool">,
  request: JsonRequest,
  fetchLocal: LocalFetch,
  notifyAnimation: (
    data: AnimationFeedback & {
      event: "animation-left-behind";
      projectId: string;
      requestId: RequestId;
    },
  ) => Promise<void>,
) {
  const id = encodeURIComponent;
  const timelinePath = (projectId: string, composition: string) =>
    `/projects/${id(projectId)}/timeline?composition=${id(composition)}`;
  server.registerTool(
    "timeline_read",
    {
      description:
        "Read the timeline: tracks including empty rows, clips, markers, and in/out range in integer frames at the composition's fps, plus the revision to pass to timeline_edit. setClip x/y are additive offsets in composition CSS pixels from authored CSS and animation, not absolute coordinates. A composition's own animation can override Position. Verify with timeline_view frames. Positive x is right and positive y is down. Null clears the offset. Position changes only the named visual clip, never linked audio. A text element's clip carries text, its words with line breaks at <br> and preserved source newlines; sourceRestrictions.text says why setClip text would be refused. Clip volume is linear gain (1 = 0 dB, null = unity). Automation is HyperFrames clip-local JSON and may contain baked volume ramps. fadeIn/fadeOut are authored frame lengths. Effective fades multiply both authored lengths by min(1, duration / (fadeIn + fadeOut)). Zero lengths stay zero.",
      inputSchema: input,
      annotations: readOnly,
    },
    ({ projectId, composition }) =>
      request(timelinePath(projectId, composition)),
  );
  server.registerTool(
    "timeline_edit",
    {
      description:
        "Apply a batch of timeline commands as one undo step. Tracks persist after their last clip is removed. removeTrack removes an unlocked empty track by index; occupied tracks refuse removal. Cutroom never rewrites animation scripts. Root tween positions are absolute composition seconds; HyperFrames does not add data-start. Actual before/after timelines detect changed animation origins, including ripples that trim and displace clips, and new razor/pasted targets. The saved edit is acknowledged first. Animation inspection follows outside the response path: only the initiating editor tab receives a transient Ask agent toast through project SSE, filtered by its per-tab origin token. Observer tabs stay quiet; MCP edits do not show editor toasts. MCP callers receive nonempty feedback afterward as a notifications/message warning from cutroom.animation, with event animation-left-behind, projectId, requestId from the originating MCP call, the saved timeline revision, composition and clip IDs/labels. There is no animation warning in the tool result. Sub-composition hosts never warn. Complete literal selectors are matched as a whole; loose hints apply only to unresolved GSAP target expressions. Unrelated DOM lookups and non-GSAP receivers do not count. Literal computed members such as gsap[\"to\"] are recognized. Pure head/tail trims preserving origin stay quiet. No warning state is stored. Attribution is best-effort; ambiguous scripts can nudge and unresolvable helpers can be missed. Prefer animated titles in their own clip-local sub-composition files, which follow their host clips. Linked clips edit together, ripple edits follow unlocked auto-select tracks, and explicit edits that cannot apply exactly fail the whole batch. Auto-select razor splits leave source-restricted clips and their linked partners whole; skippedClips in the response names each clip, its label and reason. Ripple edits refuse atomically when a participating clip cannot be cut or removed exactly, naming its track and suggesting turning off auto-select there to ripple without it. Pass the revision from timeline_read; the response carries the next one. setClip x/y are additive offsets in composition CSS pixels from authored CSS and animation, not absolute coordinates. A composition's own animation can override Position. Verify with timeline_view frames. Positive x is right and positive y is down. Null clears the offset. Position changes only the named visual clip, never linked audio. setClip text replaces a text element's words, with newlines written as <br>; it is refused for media, nested markup, uncertain multiline whitespace, and certain script writes by id. Other scripts can replace the committed words. Verify text edits with timeline_view at relevant frames; the editor warns without blocking when rendered text differs. Clip volume is linear gain (1 = 0 dB, null = unity). Automation is HyperFrames clip-local JSON that may hold baked ramps. setClip automation:null clears it. Fade values are authored frame lengths. Effective fades multiply both lengths by min(1, duration / (fadeIn + fadeOut)), with zero lengths staying zero.",
      inputSchema: CommandBatchSchema.extend({ projectId: input.projectId }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId, ...batch }, { requestId }) =>
      request(`/projects/${id(projectId)}/commands`, "POST", batch, (data) =>
        notifyAnimation({
          event: "animation-left-behind",
          requestId,
          projectId,
          ...data,
        }),
      ),
  );
  server.registerTool(
    "timeline_destinations",
    {
      description:
        "Read or set the destination tracks: where the owner's Insert (F9), Overwrite (F10) and Media menu placements put picture and sound, shown on the track headers. Returns the video and audio track indexes. Pass video or audio to change one; the editor follows at once. Destinations are view preferences, outside undo history. To place media there yourself, pass these indexes to a timeline_edit insert as track and linkedAudio.track.",
      inputSchema: {
        ...input,
        video: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Index of the video track to make the destination"),
        audio: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Index of the audio track to make the destination"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId, composition, video, audio }) => {
      const path = `/projects/${id(projectId)}/timeline-destinations?composition=${id(composition)}`;
      return video === undefined && audio === undefined
        ? request(path)
        : request(path, "PUT", { video, audio });
    },
  );
  server.registerTool(
    "timeline_copy",
    {
      description:
        "Copy selected clips and linked partners into a project-scoped in-app clipboard snapshot. No history write. Pass its id as clipboardId to a timeline_edit paste command. The snapshot survives cuts and timeline switches until this server restarts. Source-restricted clips refuse the whole copy.",
      inputSchema: CopyClipsSchema.extend({ projectId: input.projectId }),
      annotations: readOnly,
    },
    ({ projectId, ...copy }) =>
      request(`/projects/${id(projectId)}/timeline/copy`, "POST", copy),
  );
  server.registerTool(
    "timeline_view",
    {
      description: "Render one timeline frame as an image.",
      inputSchema: { ...input, frame: z.number().int().nonnegative() },
      // The thumbnail route captures in the capability-scoped, opaque renderer.
      annotations: readOnly,
    },
    async (
      { projectId, composition, frame },
      extra,
    ): Promise<CallToolResult> => {
      const failed = (text: string): CallToolResult => ({
        content: [{ type: "text", text }],
        isError: true,
      });
      const read = await fetchLocal(
        `/api/cutroom${timelinePath(projectId, composition)}`,
        { signal: extra.signal },
      );
      if (!read.ok)
        return failed(`Cutroom returned ${read.status}: ${await read.text()}`);
      const { timeline } = TimelineViewSchema.parse(await read.json());
      // Full precision: the renderer floors seek times onto frames.
      const seconds = frameTime(frame, timeline.fps);
      const image = await fetchLocal(
        `/api/projects/${id(projectId)}/thumbnail/${composition.split("/").map(id).join("/")}?t=${seconds}&format=jpeg&output=source`,
        { signal: extra.signal },
      );
      if (!image.ok)
        return failed(
          `Cutroom returned ${image.status}: ${await image.text()}`,
        );
      return {
        content: [
          {
            type: "image",
            data: Buffer.from(await image.arrayBuffer()).toString("base64"),
            mimeType: "image/jpeg",
          },
          { type: "text", text: `Frame ${frame} (${seconds.toFixed(3)}s)` },
        ],
      };
    },
  );
}
