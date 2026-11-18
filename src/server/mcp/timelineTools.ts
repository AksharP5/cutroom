import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AnimationFeedback } from "../../shared/timeline/schema";
import { frameTime } from "../../shared/timeline/apply";
import { TimelineDestinationsSchema } from "../../shared/timeline/view";
import type { RequestOptions } from "./server";
import { agentTimeline, editReply, filterTimeline } from "./timelineReply";
import {
  CommandBatchSchema,
  CommandSchema,
  CopyClipsSchema,
  TimelineViewSchema,
} from "../../shared/timeline/schema";
import type { CommandInput, TimelineView } from "../../shared/timeline/schema";
import { mixLoudnessFx } from "../../shared/timeline/fx";
import { DuckRequestSchema, LoudnessRequestSchema } from "../timeline/audio";

type JsonRequest = (
  path: string,
  method?: string,
  body?: unknown,
  options?: RequestOptions,
) => Promise<CallToolResult>;
/** Fetches a path on the local server, such as `/api/projects/...`. */
type LocalFetch = (path: string, init?: RequestInit) => Promise<Response>;

const MAX_VIEW_FRAMES = 8;

/** Scales a JPEG down to `width` pixels wide with the FFmpeg that exports already need. */
async function scaleJpeg(jpeg: Uint8Array, width: number, signal: AbortSignal) {
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new Error("Install FFmpeg to scale timeline_view images.");
  const child = Bun.spawn(
    [
      ffmpeg,
      "-v",
      "error",
      "-f",
      "jpeg_pipe",
      "-i",
      "pipe:0",
      "-vf",
      `scale='min(${width},iw)':-2:flags=lanczos`,
      "-q:v",
      "3",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "pipe:1",
    ],
    { stdin: jpeg, stdout: "pipe", stderr: "pipe", signal },
  );
  const [scaled, error, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`FFmpeg could not scale the frame: ${error}`);
  return scaled;
}

const input = {
  projectId: z.string().describe("Project ID returned by projects_list"),
  composition: z
    .string()
    .default("index.html")
    .describe("Composition file within the project"),
};
const failed = (status: number, message: string): CallToolResult => ({
  content: [{ type: "text", text: `Cutroom returned ${status}: ${message}` }],
  isError: true,
});
const failedResponse = async (response: Response) => {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failed(response.status, text);
  }
  const error = z.object({ error: z.string() }).safeParse(body);
  return failed(response.status, error.success ? error.data.error : text);
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
  /** The whole timeline as a read returns it, or the failure to show the agent. */
  const readView = async (
    projectId: string,
    composition: string,
    signal?: AbortSignal,
  ) => {
    const read = await fetchLocal(
      `/api/cutroom${timelinePath(projectId, composition)}`,
      { signal },
    );
    if (!read.ok)
      return { ok: false as const, failure: await failedResponse(read) };
    return {
      ok: true as const,
      view: TimelineViewSchema.parse(await read.json()),
    };
  };
  server.registerTool(
    "timeline_read",
    {
      description:
        "Read the timeline in integer frames at the composition's fps: tracks (including empty ones), clips, markers, the in/out range, and the revision to pass to timeline_edit. On long timelines pass from/to and tracks to get only the clips and markers there; tracks and the revision always cover the whole timeline. agentChanges lists clips still awaiting the owner's review; pass clipEdits: true for the owner and agent edit ledger behind it. Clip fields: x/y are additive offsets in composition CSS pixels on top of authored CSS and animation, not coordinates; positive x is right, positive y is down, null is none. scaleX/scaleY (1 = own size), rotation (degrees clockwise about the centre) and crop (pixels off each edge of the clip's own box) apply on top of authored transforms; null is none, and sourceRestrictions.transform says why setClip would refuse them. The composition's own animation can override all of these, so check with timeline_view; they never move linked audio. keyframes animates position, scale, rotation, crop and opacity: per property, keyframes {frame, value, ease} at clip-local frames (0 is the clip's first frame), in the static fields' units, which read null while their property has keyframes; ease (linear, ease-in, ease-out, ease-in-out, hold) shapes the motion to the next keyframe, and the value holds before the first and after the last. Edit them with setKeyframe, removeKeyframe and moveKeyframe. text holds a text element's words, with <br> and preserved source line breaks as newlines; sourceRestrictions.text says why setClip text would be refused. title holds a Cutroom title's look and motion. style holds any other visual clip's inline look as setClip.style writes it (text style, fill, radius, shadow, blur, width, height, objectFit), with only the fields set inline in that form; the composition's stylesheets decide the rest. volume is linear clip gain (1 = 0 dB, null = unity). A track's volume is a separate gain stage on top; clips with trackGainWarning keep their authored audio group and skip it. authoredAudioGroupId names the clip's authored bus. timeline.authoredAudioGroups lists this composition's bus declarations and their linear gain, including empty groups. setAudioGroup {clipId, volume} changes the shared gain while preserving routing, FX, mute and automation. It refuses missing or source-restricted buses and locked member tracks. Each stage goes up to +12 dB. automation is null or the clip's volume envelope: volume lists points {frame, gain} at clip-local frames, gain being linear on top of the clip's gain (1 = no change), straight between points and held before the first and after the last; set it with setClip.automation {volume: [...]}. lanes names effect-parameter lanes, which setClip.automation keeps. A baked ramp may bend between points; writing points back makes straight runs. fx on a clip or a track is its audio effect chain in signal order: {id, type, params} with params left out at their defaults, enabled false when bypassed, and preset naming the preset that added it. A track's chain processes every clip on it except those with trackGainWarning. timeline.masterFx, when present, is the master bus chain over the whole mix, set with setMaster; audio_loudness puts the mix's loudness gain there. Change them with setClip.fx and setTrack.fx, which take the whole chain; an entry with an existing id keeps the values it leaves out, and {preset} adds a preset's effects. fadeIn/fadeOut are authored frame lengths; playback scales both by min(1, duration / (fadeIn + fadeOut)). transitionIn/transitionOut hold a cut's transition on both clips that meet there; clip start and duration stay at the cut, and the media running past it under the transition is not counted. link groups clips that edit as one; link and unlink change it. syncOffset, present only when linked picture and sound of one file have drifted apart, is how many frames this clip plays its source later than its partner (negative is earlier); moving it by -syncOffset frames or slipping it by syncOffset resyncs it.",
      inputSchema: {
        ...input,
        from: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "First frame of interest; clips ending after it are returned",
          ),
        to: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Exclusive end frame of interest"),
        tracks: z
          .array(z.number().int().nonnegative())
          .min(1)
          .optional()
          .describe("Track indexes whose clips to return; omit for all"),
        clipEdits: z
          .boolean()
          .default(false)
          .describe("Include the clip edit ledger"),
      },
      annotations: readOnly,
    },
    async ({ projectId, composition, from, to, tracks, clipEdits }) => {
      const result = await readView(projectId, composition);
      if (!result.ok) return result.failure;
      const { clipEdits: ledger, timeline, ...view } = result.view;
      const reply = {
        ...view,
        ...(clipEdits && { clipEdits: ledger }),
        timeline: agentTimeline(filterTimeline(timeline, { from, to, tracks })),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(reply) }],
        structuredContent: { result: reply },
      };
    },
  );
  server.registerTool(
    "timeline_edit",
    {
      description:
        "Apply a batch of timeline commands as one undo step, in order and atomically: a command that cannot apply exactly fails the whole batch, naming its index. Pass the revision from timeline_read; stale revisions are refused. Fields mean what timeline_read says. " +
        "The reply has the next revision and only what changed: changes.clips, changes.tracks, changes.markers and changes.authoredAudioGroups each list added (complete, so new clip IDs from razor, insert and paste and generated audio group IDs are here), changed (the id or index with the new values of changed fields; null means cleared) and removed (ids or indexes), plus range and duration when they change. skippedClips names clips an auto-select razor left whole, with the reason. warnings names clips on an edited track that track gain skips; tell the user, and keep their authored group. The last text line says what the edit did. Pass fullTimeline: true to also get the whole timeline. " +
        "Linked clips edit together, and ripple edits follow unlocked auto-select tracks. A ripple refuses when a participating clip cannot be cut or removed exactly, naming its track; turning off auto-select there ripples without it. Removing time through the middle of a text element or still image shortens it; video, audio and sub-compositions split. Tracks stay when emptied; removeTrack removes an unlocked empty one. A cutting command's ids names its new pieces, keyed by source clip id in cut order (a ripple through several ranges cuts last range first); an id ever used in the project is refused with duplicate_id. " +
        'For a lower third, name or heading, insert a title: clip {kind: "title", text, duration, title}, with a title.size that suits the composition (default 64 px). Its entrance stays on the clip\'s first frame and its exit on the last through every edit; a razor keeps the entrance on the first piece and the exit on the second. Verify setClip text with timeline_view, since other scripts can replace the words. ' +
        "Cutroom never rewrites animation scripts, and root tweens sit at absolute composition seconds, so moving or cutting a clip can leave its animation behind. The reply never says so; afterwards the server may send a notifications/message warning from logger cutroom.animation with event animation-left-behind, projectId, the originating requestId, revision, composition and the clips' ids and labels. Detection is best-effort. Put bespoke animation in clip-local sub-composition files, which follow their host clips.",
      inputSchema: CommandBatchSchema.extend({
        projectId: input.projectId,
        fullTimeline: z
          .boolean()
          .default(false)
          .describe("Also return the whole timeline after the edit"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectId, fullTimeline, ...batch }, { requestId }) => {
      const before = await readView(projectId, batch.composition);
      if (!before.ok) return before.failure;
      // A read at another revision cannot show what this edit changed.
      const exact = before.view.revision === batch.expectedRevision;
      return request(`/projects/${id(projectId)}/commands`, "POST", batch, {
        followup: (data) =>
          notifyAnimation({
            event: "animation-left-behind",
            requestId,
            projectId,
            ...data,
          }),
        reply: (result) =>
          editReply(
            before.view,
            TimelineViewSchema.parse(result),
            fullTimeline || !exact,
          ),
      });
    },
  );
  /** Applies mix commands as one undo step, reporting what was measured beside the changes. */
  const commit = (
    projectId: string,
    before: TimelineView,
    label: string,
    commands: CommandInput[],
    measured: object,
  ) =>
    request(
      `/projects/${id(projectId)}/commands`,
      "POST",
      {
        composition: before.composition,
        expectedRevision: before.revision,
        label,
        commands,
      },
      {
        reply: (result) => ({
          measured,
          ...editReply(before, TimelineViewSchema.parse(result), false),
        }),
      },
    );
  /** Measures what a mix edit needs where the media is, then commits it. */
  const applyPlan = async (
    projectId: string,
    composition: string,
    kind: "duck" | "loudness",
    body: object,
  ) => {
    const before = await readView(projectId, composition);
    if (!before.ok) return before.failure;
    const planned = await fetchLocal(
      `/api/cutroom/projects/${id(projectId)}/audio/${kind}?composition=${id(composition)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!planned.ok) return failedResponse(planned);
    const { label, commands, ...measured } = z
      .looseObject({ label: z.string(), commands: z.array(CommandSchema) })
      .parse(await planned.json());
    return commit(projectId, before.view, label, commands, measured);
  };
  const edits = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  };
  server.registerTool(
    "audio_duck",
    {
      description:
        "Duck a clip, such as a music bed, under the voice: its volume comes down by depth dB while any voice speaks, over attack seconds before speech and back over release seconds after, staying down through pauses too short to come back up in. Speech is found in what each voice clip plays. The result is the bed's volume points (timeline_read automation.volume), multiplied into any it had, as one undo step; the owner can drag them. Reply: measured.voices (the clips listened to), measured.speech (spans found), and the edit's changes. Run it again after moving the voice, or undo it first, since it multiplies into the points that are there.",
      inputSchema: { ...input, ...DuckRequestSchema.shape },
      annotations: edits,
    },
    ({ projectId, composition, ...duck }) =>
      applyPlan(projectId, composition, "duck", duck),
  );
  server.registerTool(
    "audio_loudness",
    {
      description:
        "Normalize loudness with an EBU R128 meter (FFmpeg ebur128), as gain only. With clipIds, measure what each clip plays at its file's own level and set its clip gain so it reaches target LUFS (default -16), held at +12 dB; measured.clips gives each clip's measured LUFS, true peak, and the level it reaches. With jobId, measure a finished whole-timeline export from export_start and set a Loudness gain effect on the master bus (timeline masterFx, setMaster) so the next export reaches target; export again to deliver it. Each is one undo step.",
      inputSchema: {
        ...input,
        target: LoudnessRequestSchema.shape.target,
        clipIds: LoudnessRequestSchema.shape.clipIds.optional(),
        jobId: z
          .string()
          .min(1)
          .optional()
          .describe("A finished whole-timeline export to measure the mix from"),
      },
      annotations: edits,
    },
    async ({ projectId, composition, target, clipIds, jobId }) => {
      if (clipIds && !jobId)
        return applyPlan(projectId, composition, "loudness", {
          clipIds,
          target,
        });
      if (!jobId || clipIds)
        return failed(400, "Pass clipIds for clips or jobId for the mix.");
      const before = await readView(projectId, composition);
      if (!before.ok) return before.failure;
      const measuring = await fetchLocal(`/api/render/${id(jobId)}/loudness`);
      if (!measuring.ok) return failedResponse(measuring);
      const measured = z
        .object({
          lufs: z.number().nullable(),
          truePeak: z.number().nullable(),
        })
        .parse(await measuring.json());
      if (measured.lufs === null)
        return failed(422, "The export is silent under the meter's gate.");
      return commit(
        projectId,
        before.view,
        `Normalize mix to ${target} LUFS`,
        [
          {
            type: "setMaster",
            fx: mixLoudnessFx(
              before.view.timeline.masterFx ?? [],
              measured.lufs,
              target,
            ),
          },
        ],
        measured,
      );
    },
  );
  server.registerTool(
    "timeline_destinations",
    {
      description:
        "Read or set destination tracks and enable flags for Insert (F9), Overwrite (F10) and Media menu placements. video/audio are track indexes; videoEnabled/audioEnabled default true. False skips that incoming kind and remembers its track. The editor follows at once; these are view preferences outside undo history. For timeline_edit placement, respect the flags: video with audio off needs clip.muted=true and no linkedAudio; video off with audio on needs an audio clip using the same source and range. Skip placement when neither source kind is enabled.",
      inputSchema: {
        ...input,
        ...TimelineDestinationsSchema.shape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ projectId, composition, ...chosen }) => {
      const path = `/projects/${id(projectId)}/timeline-destinations?composition=${id(composition)}`;
      return !Object.keys(chosen).length
        ? request(path)
        : request(path, "PUT", chosen);
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
      description: `Render timeline frames as JPEG images, each followed by its frame number and time. Pass frame for one, or frames for up to ${MAX_VIEW_FRAMES} in one call. width scales each image down, keeping its aspect ratio; omit it for the composition's full size. A few hundred pixels is enough to check layout and timing, and costs far less context. Composition script and load failures return an error naming the file and message instead of a misleading static frame.`,
      inputSchema: {
        ...input,
        frame: z.number().int().nonnegative().optional(),
        frames: z
          .array(z.number().int().nonnegative())
          .min(1)
          .max(MAX_VIEW_FRAMES)
          .optional()
          .describe("Several frames to render, in order"),
        width: z
          .number()
          .int()
          .min(64)
          .max(3840)
          .optional()
          .describe("Image width in pixels; never larger than the composition"),
      },
      // The thumbnail route captures in the capability-scoped, opaque renderer.
      annotations: readOnly,
    },
    async (
      { projectId, composition, frame, frames, width },
      extra,
    ): Promise<CallToolResult> => {
      const wanted =
        frame === undefined ? frames : frames ? undefined : [frame];
      if (!wanted)
        return {
          content: [{ type: "text", text: "Pass either frame or frames." }],
          isError: true,
        };
      const read = await readView(projectId, composition, extra.signal);
      if (!read.ok) return read.failure;
      const { timeline } = read.view;
      const content: CallToolResult["content"] = [];
      // One at a time: captures share one renderer queue, and the first failure answers.
      for (const at of wanted) {
        // Full precision: the renderer floors seek times onto frames.
        const seconds = frameTime(at, timeline.fps);
        const image = await fetchLocal(
          `/api/projects/${id(projectId)}/thumbnail/${composition.split("/").map(id).join("/")}?t=${seconds}&format=jpeg&output=source`,
          { signal: extra.signal },
        );
        if (!image.ok) return failedResponse(image);
        const jpeg = new Uint8Array(await image.arrayBuffer());
        content.push(
          {
            type: "image",
            data: Buffer.from(
              width ? await scaleJpeg(jpeg, width, extra.signal) : jpeg,
            ).toString("base64"),
            mimeType: "image/jpeg",
          },
          { type: "text", text: `Frame ${at} (${seconds.toFixed(3)}s)` },
        );
      }
      return { content };
    },
  );
}
