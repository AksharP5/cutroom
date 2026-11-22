import { ClipBackgroundSchema } from "../../shared/matte";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ProjectFormatSchema } from "../../shared/projectFormat";
import type { AnimationFeedback } from "../../shared/timeline/schema";
import { frameTime, planBatchTransitions } from "../../shared/timeline/apply";
import { TimelineDestinationsSchema } from "../../shared/timeline/view";
import type { RequestOptions } from "./server";
import {
  TimelineReplyFormatSchema,
  editReply,
  readTimelineReply,
} from "./timelineReply";
import {
  CommandBatchSchema,
  CommandSchema,
  CopyClipsSchema,
  TimelineViewSchema,
} from "../../shared/timeline/schema";
import type { CommandInput, TimelineView } from "../../shared/timeline/schema";
import { mixLoudnessFx } from "../../shared/timeline/fx";
import { DuckRequestSchema, LoudnessRequestSchema } from "../timeline/audio";
import { registerVersionTools } from "./versionTools";

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
    clipEdits = false,
  ) => {
    const read = await fetchLocal(
      `/api/cutroom${timelinePath(projectId, composition)}${clipEdits ? "&clipEdits=1" : ""}`,
      { signal },
    );
    if (!read.ok)
      return { ok: false as const, failure: await failedResponse(read) };
    return {
      ok: true as const,
      view: TimelineViewSchema.parse(await read.json()),
    };
  };
  /** Each video clip's background with its matte state, or undefined when it cannot be read. */
  const readBackgrounds = async (projectId: string, composition: string) => {
    const response = await fetchLocal(
      `/api/cutroom/projects/${id(projectId)}/mattes?composition=${id(composition)}`,
    );
    if (!response.ok) return undefined;
    const { clips } = z
      .object({
        clips: z.record(z.string(), ClipBackgroundSchema.nullable()),
      })
      .parse(await response.json());
    return new Map(
      Object.entries(clips).flatMap(([clip, background]) =>
        background ? [[clip, background] as const] : [],
      ),
    );
  };
  /** Queues the mattes Remove clips lack, as the open editor does after an edit. */
  const syncMattes = (
    projectId: string,
    composition: string,
    retry: readonly string[] = [],
  ) =>
    fetchLocal(
      `/api/cutroom/projects/${id(projectId)}/mattes/sync?composition=${id(composition)}&retry=${retry.map(id).join(",")}`,
      { method: "POST" },
    );
  server.registerTool(
    "timeline_read",
    {
      description:
        "Read the timeline in integer frames at the composition's fps: tracks (including empty ones), clips, markers, the in/out range, and the revision to pass to timeline_edit. Clips come in full while their JSON stays under 256 KiB, about 490 clips. Past that, an unfiltered read returns timeline.clipSummary with per-track counts and half-open frame spans in place of timeline.clips, and a read filtered by from/to or tracks returns compact clips. Pass from/to and tracks for exact clip details. Frame filters also narrow markers; tracks and the revision cover the whole timeline. Compact clips omit null fields, playbackRate 1, hasAudio and adjustment false, enabled true, fadeIn and fadeOut 0, style {} and fx []. Authored values such as opacity 1 and volume 0 stay. agentChanges lists clips still awaiting the owner's review; pass clipEdits: true for the owner and agent edit ledger behind it. Clip fields: x/y are additive offsets in composition CSS pixels on top of authored CSS and animation, not coordinates; positive x is right, positive y is down, null is none. scaleX/scaleY (1 = own size), rotation (degrees clockwise about the centre) and crop (pixels off each edge of the clip's own box) apply on top of authored transforms; null is none, and sourceRestrictions.transform says why setClip would refuse them. The composition's own animation can override all of these, so check with timeline_view; they never move linked audio. keyframes animates position, scale, rotation, crop and opacity: per property, keyframes {frame, value, ease} at clip-local frames (0 is the clip's first frame), in the static fields' units, which read null while their property has keyframes; ease (linear, ease-in, ease-out, ease-in-out, hold) shapes the motion to the next keyframe, and the value holds before the first and after the last. Edit them with setKeyframe, removeKeyframe and moveKeyframe. text holds a text element's words, with <br> and preserved source line breaks as newlines; sourceRestrictions.text says why setClip text would be refused. title holds a Cutroom title's look and motion. style holds any other visual clip's inline look as setClip.style writes it (text style, fill, radius, shadow, blur, width, height, objectFit), with only the fields set inline in that form; the composition's stylesheets decide the rest. volume is linear clip gain (1 = 0 dB, null = unity). A track's volume is a separate gain stage on top; clips with trackGainWarning keep their authored audio group and skip it. authoredAudioGroupId names the clip's authored bus. timeline.authoredAudioGroups lists this composition's buses, including empty ones: id, label, linear volume, muted, solo, fx, automated (an automation lane owns its gain) and members (clips routed to it). setAudioGroup {group, label, volume, muted, solo, fx, automation: null} changes one bus, only the fields given; {clipId} instead of group names a member's bus. removeAudioGroup {group} deletes a bus and returns its clips to track mixing. Both refuse missing or source-restricted buses and locked member tracks. While anything is soloed, a clip sounds when its track or its bus is soloed; mute wins. Each stage goes up to +12 dB. automation is null or the clip's volume envelope: volume lists points {frame, gain} at clip-local frames, gain being linear on top of the clip's gain (1 = no change), straight between points and held before the first and after the last; set it with setClip.automation {volume: [...]}. lanes names effect-parameter lanes, which setClip.automation keeps. A baked ramp may bend between points; writing points back makes straight runs. fx on a clip or a track is its audio effect chain in signal order: {id, type, params} with params left out at their defaults, enabled false when bypassed, and preset naming the preset that added it. A track's chain processes every clip on it except those with trackGainWarning. timeline.main is the master bus over the whole mix: volume (linear, -60 to +12 dB, after its effects) and fx, its chain; set either with setMaster. audio_loudness puts the mix's loudness gain in main.fx. Change them with setClip.fx and setTrack.fx, which take the whole chain; an entry with an existing id keeps the values it leaves out, and {preset} adds a preset's effects. fadeIn/fadeOut are authored frame lengths; playback scales both by min(1, duration / (fadeIn + fadeOut)). transitionIn/transitionOut hold a cut's transition on both clips that meet there; clip start and duration stay at the cut, and the media running past it under the transition is not counted. link groups clips that edit as one; link and unlink change it. syncOffset, present only when linked picture and sound of one file have drifted apart, is how many frames this clip plays its source later than its partner (negative is earlier); moving it by -syncOffset frames or slipping it by syncOffset resyncs it. region is a zoom on that clip, or an adjustment layer's zoom, blur or highlight: {effect, box {x, y, width, height} in fractions of the frame from the top left, in and out ramp frames at the clip's edges, ease, blur px, dim, area, radius px, feather px}. A clip with adjustment true is an adjustment layer: it draws nothing itself and applies its region to every picture on the video tracks below it while it plays. background is null when a video keeps its background; when it is removed, {mode: \"remove\", state, progress, error, shrink, soften}: state is ready (the cutout shows), waiting, running (progress 0 to 1), needs-model (matte_download first) or failed (error says why); shrink and soften are edge pixels. Set it with setClip.background and poll matte_status until ready before a render that needs the cutout.",
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
        replyFormat: TimelineReplyFormatSchema.default("auto").describe(
          "auto keeps the original shape until the clips pass 256 KiB of JSON; compact omits clip defaults; legacy always includes the original clip fields and whole clip list unless filtered",
        ),
        clipEdits: z
          .boolean()
          .default(false)
          .describe("Include the clip edit ledger"),
      },
      annotations: readOnly,
    },
    async ({
      projectId,
      composition,
      from,
      to,
      tracks,
      clipEdits,
      replyFormat,
    }) => {
      const result = await readView(
        projectId,
        composition,
        undefined,
        clipEdits,
      );
      if (!result.ok) return result.failure;
      const {
        clipEdits: ledger,
        reviewEntries: _reviewEntries,
        timeline,
        ...view
      } = result.view;
      // Matte progress is read only when a clip has its background removed.
      const backgrounds = timeline.clips.some((clip) => clip.background)
        ? await readBackgrounds(projectId, composition)
        : undefined;
      const reply = {
        ...view,
        ...(clipEdits && { clipEdits: ledger }),
        timeline: readTimelineReply(
          timeline,
          { from, to, tracks },
          replyFormat,
          backgrounds,
        ),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(reply) }],
        structuredContent: { result: reply },
      };
    },
  );
  server.registerTool(
    "timeline_format_preview",
    {
      description:
        "Preview a project format change before committing setFormat through timeline_edit. Reports how many clip edges move and the largest timing shift in milliseconds. Has no effect on the project.",
      inputSchema: {
        ...input,
        expectedRevision: CommandBatchSchema.shape.expectedRevision,
        format: ProjectFormatSchema,
      },
      annotations: readOnly,
    },
    ({ projectId, ...body }) =>
      request(`/projects/${id(projectId)}/format-preview`, "POST", body),
  );
  server.registerTool(
    "timeline_edit",
    {
      description:
        "Apply a batch of timeline commands as one undo step, in order and atomically: a command that cannot apply exactly fails the whole batch, naming its index. Pass the revision from timeline_read; stale revisions are refused. Fields mean what timeline_read says. Use setFormat {width, height, fps: {num, den}} on its own to change picture size and snap each clip edge to the new grid while preserving source timing, or preview it with timeline_format_preview. setFormat always returns the complete timeline at the new rate, with every clip field. " +
        "The reply has the next revision and only what changed: changes.clips, changes.tracks, changes.markers and changes.authoredAudioGroups each list added (complete, so new clip IDs from razor, insert and paste and generated audio group IDs are here), changed (the id or index with the new values of changed fields; null means cleared) and removed (ids or indexes), plus range, duration, fps, size and main when they change. skippedClips names clips an auto-select razor left whole, with the reason. warnings names clips on an edited track that track gain skips; tell the user, and keep their authored group. For other edits a reply is compact when replyFormat is compact, or when its clip changes pass 256 KiB of JSON. In a compact reply, clip additions omit defaults as in timeline_read, and moved clips may not be in changes.clips.changed: 16 or more clips whose only change is the same shift in start are listed in changes.clips.shifted as {by, ids}, so read both lists, adding by frames to each listed clip's previous start. Other changes give the new values, including explicit resets. The last text line says what the edit did. Pass fullTimeline: true to also get every clip, or use replyFormat: legacy if you need the original delta shape. " +
        "Linked clips edit together, and ripple edits follow unlocked auto-select tracks. A ripple refuses when a participating clip cannot be cut or removed exactly, naming its track; turning off auto-select there ripples without it. Removing time through the middle of a text element or still image shortens it; video, audio and sub-compositions split. Tracks stay when emptied; removeTrack removes an unlocked empty one. A cutting command's ids names its new pieces, keyed by source clip id in cut order (a ripple through several ranges cuts last range first); an id ever used in the project is refused with duplicate_id. " +
        "Use freeze {clipId, at} to insert a silent, two-second still at an interior frame of a local video. Linked audio resumes with the right half. " +
        'For a lower third, name or heading, insert a title: clip {kind: "title", text, duration, title}, with a title.size that suits the composition (default 64 px). Its entrance stays on the clip\'s first frame and its exit on the last through every edit; a razor keeps the entrance on the first piece and the exit on the second. Verify setClip text with timeline_view, since other scripts can replace the words. ' +
        'To zoom into part of the picture ("zoom into the button"), blur it or highlight it, look first with timeline_view, then turn the region you saw into fractions of the frame: x and width divided by the image width, y and height by its height, with some margin around it. For a zoom over everything at that moment, insert an adjustment layer on a video track above the pictures: clip {kind: "adjustment", duration, region: {effect: "zoom", box}}; it ramps in over region.in frames and back out over region.out (0 holds it to the end), shaped by region.ease (ease-in-out by default; linear, ease, ease-in, ease-out, expo-in, expo-out). To zoom only one clip, setClip {clipId, region: {effect: "zoom", box}}. A zoom\'s box keeps the frame\'s shape around the box you give and magnifies 1/width, up to 10x. Blur (area inside or outside) and highlight (dim and optional blur outside the box, with radius and feather) go on an adjustment layer. setClip.region changes only the fields it names, and null removes it. Check the result with timeline_view at the ramp\'s end. ' +
        "Cutroom never rewrites animation scripts, and root tweens sit at absolute composition seconds, so moving or cutting a clip can leave its animation behind. The reply never says so; afterwards the server may send a notifications/message warning from logger cutroom.animation with event animation-left-behind, projectId, the originating requestId, revision, composition and the clips' ids and labels. Detection is best-effort. Put bespoke animation in clip-local sub-composition files, which follow their host clips.",
      inputSchema: CommandBatchSchema.extend({
        projectId: input.projectId,
        replyFormat: TimelineReplyFormatSchema.default("auto").describe(
          "auto keeps the original shape until clip changes pass 256 KiB of JSON; compact omits defaults on added clips and groups 16 or more uniform shifts into changes.clips.shifted; legacy keeps the original clip fields and per-clip changes",
        ),
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
    async (
      { projectId, fullTimeline, replyFormat, ...batch },
      { requestId },
    ) => {
      const before = await readView(projectId, batch.composition);
      if (!before.ok) return before.failure;
      const formatChanged = batch.commands.some(
        ({ type }) => type === "setFormat",
      );
      // A read at another revision cannot show what this edit changed.
      const exact = before.view.revision === batch.expectedRevision;
      const backgrounds = batch.commands.flatMap((command) =>
        command.type === "setClip" && command.background !== undefined
          ? [command.clipId]
          : [],
      );
      const result = await request(
        `/projects/${id(projectId)}/commands`,
        "POST",
        batch,
        {
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
              formatChanged || fullTimeline || !exact,
              exact && !formatChanged ? replyFormat : "legacy",
            ),
        },
      );
      if (result.isError || !backgrounds.length) return result;
      // The edit has landed; the matte jobs run after it, without an editor open.
      // Remove on a clip whose matte failed runs it again.
      await syncMattes(
        projectId,
        batch.composition,
        batch.commands.flatMap((command) =>
          command.type === "setClip" && command.background?.mode === "remove"
            ? [command.clipId]
            : [],
        ),
      );
      const states = await readBackgrounds(projectId, batch.composition);
      const background = Object.fromEntries(
        backgrounds.flatMap((clipId) => {
          const state = states?.get(clipId);
          return state ? [[clipId, state]] : [];
        }),
      );
      const structured = z
        .object({ result: z.looseObject({}) })
        .safeParse(result.structuredContent);
      return {
        ...result,
        content: [
          ...result.content,
          {
            type: "text",
            text: `Background: ${JSON.stringify(background)}. Poll matte_status for progress.`,
          },
        ],
        ...(structured.success && {
          structuredContent: {
            ...structured.data,
            result: { ...structured.data.result, background },
          },
        }),
      };
    },
  );
  /** Applies mix commands as one undo step, reporting what was measured beside the changes. */
  const commit = (
    projectId: string,
    before: TimelineView,
    label: string,
    commands: CommandInput[],
    measured: object,
    noteId?: string,
  ) =>
    request(
      `/projects/${id(projectId)}/commands`,
      "POST",
      {
        composition: before.composition,
        expectedRevision: before.revision,
        label,
        commands,
        noteId,
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
  registerVersionTools(server, readView, request);
  const edits = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  };
  server.registerTool(
    "timeline_add_transitions",
    {
      description:
        "Add default centred transitions to every cut between two selected clips on the same unlocked track, as one undo step. Scope both includes the selected clips' linked partners. The reply counts picture and sound cuts separately and reports how many transitions were added, kept, skipped for lack of handles, or shortened to fit. If none fit, the timeline is left unchanged.",
      inputSchema: {
        ...input,
        clipIds: z.array(z.string().min(1)).min(2),
        scope: z.enum(["both", "video", "audio"]).default("both"),
        expectedRevision: CommandBatchSchema.shape.expectedRevision,
        noteId: CommandBatchSchema.shape.noteId,
      },
      annotations: edits,
    },
    async ({
      projectId,
      composition,
      clipIds,
      scope,
      expectedRevision,
      noteId,
    }) => {
      const before = await readView(projectId, composition);
      if (!before.ok) return before.failure;
      if (before.view.revision !== expectedRevision)
        return failed(
          409,
          "Timeline changed. Read it again before adding transitions.",
        );
      const ids = new Set(before.view.timeline.clips.map(({ id }) => id));
      const missing = clipIds.find((id) => !ids.has(id));
      if (missing) return failed(404, `No clip has id ${missing}.`);
      const { cuts, kept, skipped, shortened } = planBatchTransitions(
        before.view.timeline,
        new Set(clipIds),
        scope,
      );
      const measured = { added: cuts.length, kept, skipped, shortened };
      if (!cuts.length) {
        const reply = { measured, revision: before.view.revision };
        return {
          content: [{ type: "text", text: JSON.stringify(reply) }],
          structuredContent: { result: reply },
        };
      }
      return commit(
        projectId,
        before.view,
        "Add transitions",
        [{ type: "setTransitions", cuts }],
        measured,
        noteId,
      );
    },
  );
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
        "Normalize loudness with an EBU R128 meter (FFmpeg ebur128), as gain only. With clipIds, measure what each clip plays at its file's own level and set its clip gain so it reaches target LUFS (default -16), held at +12 dB; measured.clips gives each clip's measured LUFS, true peak, and the level it reaches. With jobId, measure a finished whole-timeline export from export_start and set a Loudness gain effect on the master bus (timeline main.fx, setMaster) so the next export reaches target; export again to deliver it. Each is one undo step.",
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
              before.view.timeline.main?.fx ?? [],
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
