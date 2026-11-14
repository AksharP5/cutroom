import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import { MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import { z } from "zod";

const frame = z.number().int().nonnegative();
const frames = z.number().int().positive();
const clipId = z.string().min(1).max(200);
const label = z.string().max(500);
/** Static gain as written to `data-volume`: 0 is silence, MAX_AUDIO_GAIN is +12 dB. */
const volume = z.number().min(0).max(MAX_AUDIO_GAIN);
/** Static CSS values are canonical to six decimals, beyond CSS parser float precision. */
const opacity = z
  .number()
  .min(0)
  .max(1)
  .overwrite((value) => Math.round(value * 1e6) / 1e6);

/** Native position edits are additive offsets, canonical to six decimal pixels. */
const position = z
  .number()
  .nullable()
  .overwrite((value) => {
    if (value === null) return null;
    const offset = Number(value.toFixed(6));
    return offset === 0 ? null : offset;
  })
  .describe(
    "Additive offset in composition CSS pixels, not an absolute coordinate. A composition's own animation can override Position. Verify with timeline_view frames. Positive x moves right; positive y moves down. Null or zero clears the offset; linked audio is unchanged.",
  );

/**
 * Plain clip text: explicit breaks and preserved source line breaks use `\n`,
 * whitespace runs collapse to one space, and each line is trimmed. No-break spaces are content.
 */
export const canonicalText = (text: string) =>
  text
    .split(/\r\n?|\n/)
    .map((line) => line.replace(/[\t\f ]+/g, " ").replace(/^ | $/g, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");

/** Timeline labels show the first nonempty authored line, including text inside markup. */
export const firstTextLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find(Boolean)
    ?.slice(0, 500) ?? "";

export const FpsSchema = z.object({
  num: z.number().int().positive(),
  den: z.number().int().positive(),
});

export const ClipKindSchema = z.enum([
  "video",
  "audio",
  "voiceover",
  "image",
  "composition",
  "element",
]);

export const TITLE_POSITIONS = [
  "lower-left",
  "lower-center",
  "lower-right",
  "center",
  "top",
] as const;
export const TITLE_MOTIONS = [
  "none",
  "fade",
  "slide",
  "scale",
  "wipe",
] as const;
export const TITLE_WEIGHTS = [400, 500, 600, 700] as const;
export const TITLE_ALIGNMENTS = ["left", "center", "right"] as const;

/**
 * Every title value is written into an HTML attribute that CSS reads with `attr()`, so each is a
 * closed set, a number, or a strict pattern: none can carry markup or CSS.
 */
const titleColor = (digits: 6 | 8) =>
  z
    .string()
    .regex(
      new RegExp(`^#[0-9a-fA-F]{${digits}}$`),
      digits === 6
        ? "Use a colour as #rrggbb."
        : "Use a colour with alpha as #rrggbbaa.",
    )
    .overwrite((value) => value.toLowerCase());
const titleMotion = z.object({
  preset: z.enum(TITLE_MOTIONS),
  frames: frame.max(100_000).describe("Length in frames; ignored for none"),
});

export const TitleSchema = z.object({
  position: z.enum(TITLE_POSITIONS),
  font: z
    .string()
    .regex(
      /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,98}[A-Za-z0-9])?$/,
      "A font family uses letters, digits, spaces, hyphens and underscores.",
    )
    .nullable()
    .describe(
      "A font family the composition declares with @font-face; null inherits the composition's font",
    ),
  size: z
    .number()
    .int()
    .min(8)
    .max(2000)
    .describe("Font size in composition pixels"),
  weight: z.union(TITLE_WEIGHTS.map((weight) => z.literal(weight))),
  color: titleColor(6),
  align: z.enum(TITLE_ALIGNMENTS),
  plate: titleColor(8)
    .nullable()
    .describe("Background plate colour with alpha; null for no plate"),
  in: titleMotion.describe("Entrance, anchored to the clip's first frame"),
  out: titleMotion.describe("Exit, ending on the clip's last frame"),
});

/** A title change: fields left out keep their values, and a motion can change one of its parts. */
export const TitleEditSchema = TitleSchema.omit({ in: true, out: true })
  .extend({ in: titleMotion.partial(), out: titleMotion.partial() })
  .partial();

export const ClipSchema = z.object({
  id: clipId,
  track: frame,
  kind: ClipKindSchema,
  start: frame,
  duration: frames,
  /** Seconds into the source for video, audio, and sub-compositions; null for other clips. */
  mediaStart: z.number().nonnegative().nullable(),
  playbackRate: z.number().positive(),
  src: z.string().nullable(),
  /** Length of the source media in seconds when it could be probed; video and audio only. */
  sourceDuration: z.number().positive().nullable(),
  /** Whether the clip plays sound: audio, and video that is neither muted nor declared silent. */
  hasAudio: z.boolean(),
  link: z.string().nullable(),
  label: z.string().nullable(),
  /** First authored line of text, projected from the parsed composition for timeline labels. */
  textPreview: z.string().max(500).optional(),
  volume: z
    .number()
    .nonnegative()
    .nullable()
    .describe("Linear clip gain, 1 = 0 dB, null = unity"),
  /** Static inline opacity; null leaves the authored stylesheet in control. */
  opacity: opacity.nullable(),
  x: position.default(null),
  y: position.default(null),
  text: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "The words of a text element, with line breaks at <br> and preserved source newlines; null for media and elements without text. setClip.text replaces them unless sourceRestrictions.text says why it cannot.",
    ),
  title: TitleSchema.nullable()
    .default(null)
    .describe(
      "A Cutroom title's look and motion; null for every other clip. Change it with setClip.title and its words with setClip.text.",
    ),
  /** Authored clip-edge fades in frames; playback proportionally scales them to fit. */
  fadeIn: frame
    .default(0)
    .describe(
      "Authored fade-in frames. Effective fades are proportionally clamped to duration",
    ),
  fadeOut: frame
    .default(0)
    .describe(
      "Authored fade-out frames. Effective fades are proportionally clamped to duration",
    ),
  /** HyperFrames clip-local automation, stored in its native attribute format. */
  automation: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "HyperFrames clip-local automation JSON, which may contain baked volume ramps",
    ),
  /** False while `data-hidden` keeps the clip out of preview and render. */
  enabled: z.boolean(),
  /** Set while `data-start` names another clip and still resolves to `start`. */
  startRef: z.object({ clipId, offset: z.number().int() }).nullable(),
  /** Source restrictions are projected by the parser, never persisted in clip attributes. */
  sourceRestrictions: z
    .object({
      copy: z.string().optional(),
      remove: z.string().optional(),
      text: z.string().optional(),
      title: z.string().optional(),
    })
    .optional(),
});

export const TrackSchema = z.object({
  index: frame,
  kind: z.enum(["video", "audio"]),
  name: z.string().nullable(),
  locked: z.boolean(),
  autoSelect: z.boolean(),
  enabled: z.boolean().default(true),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
});

export const MarkerColorSchema = z.enum([
  "blue",
  "cyan",
  "green",
  "yellow",
  "red",
  "pink",
  "purple",
]);

export const MarkerSchema = z.object({
  id: z.string().min(1).max(200),
  frame,
  duration: frame,
  name: label,
  note: z.string().max(20_000),
  color: MarkerColorSchema,
});

/** Half-open frame range `[in, out)`; either side may be unset. */
export const RangeSchema = z.object({
  in: frame.nullable(),
  out: frame.nullable(),
});

export const TimelineSchema = z.object({
  fps: FpsSchema,
  duration: frame,
  tracks: z.array(TrackSchema),
  clips: z.array(ClipSchema),
  markers: z.array(MarkerSchema),
  range: RangeSchema,
});

export const InsertClipSchema = z.object({
  id: clipId
    .optional()
    .describe(
      "Element id, never used before in this project; when omitted, the file name and a random suffix",
    ),
  kind: z.enum(["video", "audio", "voiceover", "image"]),
  src: z.string().min(1).max(2_000).describe("Project-relative media path"),
  duration: frames.describe("Length on the timeline in frames"),
  mediaStart: z
    .number()
    .nonnegative()
    .default(0)
    .overwrite((seconds) => Math.round(seconds * 1e6) / 1e6)
    .describe(
      "Seconds into the source where the clip begins, to the microsecond. With duration, this places part of a file, as marks in the source viewer do",
    ),
  label: label.optional(),
  volume: volume.optional(),
  muted: z.boolean().default(false).describe("Video only: drop its sound"),
});

const titleText = z
  .string()
  .max(20_000)
  .overwrite(canonicalText)
  .refine((text) => text.length > 0, "Text cannot be empty.");

export const InsertTitleSchema = z.object({
  id: clipId
    .optional()
    .describe(
      "Element id, never used before in this project; when omitted, title and a random suffix",
    ),
  kind: z.literal("title"),
  text: titleText.describe("The title's words; a newline starts a new line"),
  duration: frames.describe("Length on the timeline in frames"),
  title: TitleEditSchema.default({}).describe(
    "Look and motion. Omitted fields take the defaults: lower-left, the composition's font at 64 px and weight 600, white, left aligned, no plate, a 0.4 s fade in and a 0.3 s fade out.",
  ),
  label: label.optional(),
});

const clipIds = z.array(clipId).min(1).max(10_000);
/** Ids for the pieces a command cuts off, so a caller knows a new clip's id before it exists. */
const pieceIds = z
  .record(clipId, z.array(clipId).min(1).max(10_000))
  .optional()
  .describe(
    "Ids for the pieces this command cuts off, keyed by the id of the clip they are cut from, in the order the command cuts them. A ripple through several ranges cuts a spanning clip once per range, last range first. Each id must never have been used in this project, even by a clip that was deleted or undone; any other id is refused with duplicate_id. Pieces without one get a new random id.",
  );

export const ClipboardSchema = z.object({
  id: z.string().min(1),
  clips: z.array(ClipSchema).min(1).max(10_000),
});

export const CopyClipsSchema = z.object({
  composition: z.string().min(1).default("index.html"),
  clipIds,
  expectedRevision: z.string().min(1),
});

export const CommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("move"),
      clipIds,
      by: z
        .number()
        .int()
        .default(0)
        .describe("Frames to shift; negative moves earlier"),
      trackBy: z
        .number()
        .int()
        .default(0)
        .describe("Tracks to shift the named clips"),
      trackClipIds: clipIds
        .optional()
        .describe(
          "Which named clips shift tracks; omitted shifts every named clip. Other named clips and linked partners still move in time.",
        ),
      linked: z
        .boolean()
        .default(true)
        .describe(
          "False moves only the named clips and leaves their linked partners where they are",
        ),
      mode: z
        .enum(["overwrite", "place"])
        .default("overwrite")
        .describe(
          "overwrite replaces covered frames on every moving clip's destination track; place refuses overlaps",
        ),
      ids: pieceIds,
    })
    .describe("Move clips and their linked partners, overwriting by default."),
  z
    .object({
      type: z.literal("trim"),
      clipId,
      edge: z.enum(["start", "end"]),
      to: frame.describe("Timeline frame the edge moves to"),
      ripple: z
        .boolean()
        .default(false)
        .describe(
          "Keep the clip's start; cut and ripple participating tracks by the exact length change",
        ),
      ids: pieceIds,
    })
    .describe(
      "Trim one edge of a clip. Every linked partner's same edge moves by the same number of frames.",
    ),
  z
    .object({
      type: z.literal("split"),
      at: frame,
      autoSelect: z
        .boolean()
        .optional()
        .describe(
          "The named targets came from auto-select. Leave unsupported clips and their linked partners whole. Omitted clipIds also uses this behavior.",
        ),
      clipIds: clipIds
        .optional()
        .describe(
          "Clips to cut; defaults to every clip under `at` on unlocked auto-select tracks",
        ),
      ids: pieceIds,
    })
    .describe("Razor clips and their linked partners at a frame."),
  z
    .object({
      type: z.literal("remove"),
      clipIds,
      ripple: z
        .boolean()
        .default(false)
        .describe(
          "Remove the selected time ranges across edited and unlocked auto-select tracks, cutting overlapping clips and closing the full gap",
        ),
      ids: pieceIds,
    })
    .describe("Lift or ripple delete clips and their linked partners."),
  z
    .object({
      type: z.literal("insert"),
      mode: z
        .enum(["place", "overwrite", "insert"])
        .default("place")
        .describe(
          "Defaults to place, which refuses overlaps. Unlike UI media drops, agents must explicitly choose overwrite to replace destination frames. insert splits and shifts unlocked auto-select tracks.",
        ),
      track: frame,
      at: frame,
      clip: z.discriminatedUnion("kind", [InsertClipSchema, InsertTitleSchema]),
      linkedAudio: z
        .object({
          id: clipId.optional(),
          track: frame
            .optional()
            .describe(
              "Audio track index for the sound. Overwrite replaces what is there; place and insert need room. Omit to route automatically.",
            ),
        })
        .optional()
        .describe(
          "Optional id and track for video's linked audio clip. Without a track, overwrite routes sound to the overwritten picture's linked audio track, refusing locked or multiple partner destinations. With no overwritten partner, use the first unlocked audio track that contains only linked picture sound and is free over the whole interval, creating one if needed; that fallback never cuts existing audio. place and insert also require room for the full interval after any ripple. Silent sources and clip.muted=true stay video-only.",
        ),
      ids: pieceIds,
    })
    .describe(
      'Add a media clip, or a title with clip.kind "title": words on screen with a preset entrance and exit that stay on the clip\'s edges through every edit.',
    ),
  z
    .object({
      type: z.literal("paste"),
      clipboardId: z
        .string()
        .min(1)
        .describe(
          "Snapshot id returned by timeline_copy, in this project and server session",
        ),
      at: frame,
      mode: z.enum(["overwrite", "insert"]).default("overwrite"),
      ids: pieceIds,
    })
    .describe(
      "Paste copied clips on their source tracks, preserving relative timing and links. Insert opens the entire copied span once.",
    ),
  z
    .object({
      type: z.literal("setClip"),
      clipId,
      label: label.nullable().optional(),
      volume: volume
        .nullable()
        .optional()
        .describe(
          "Linear clip gain, 0 for silence, 1 = 0 dB, null = unity, up to +12 dB",
        ),
      automation: z
        .null()
        .optional()
        .describe(
          "Clear HyperFrames automation, including baked volume ramps. Null only",
        ),
      fadeIn: frame
        .optional()
        .describe(
          "Authored fade-in length in frames; 0 clears it. Playback proportionally scales fades to fit the clip.",
        ),
      fadeOut: frame
        .optional()
        .describe(
          "Authored fade-out length in frames; 0 clears it. Playback proportionally scales fades to fit the clip.",
        ),
      opacity: opacity.nullable().optional(),
      x: position.optional(),
      y: position.optional(),
      text: titleText
        .optional()
        .describe(
          "Replace a text element's words. Newlines become <br>; other whitespace collapses as HTML renders it. Refused for media, elements without text, and nested markup, uncertain multiline whitespace, or certain script writes by id. Other scripts can replace the saved words. Verify with timeline_view frames.",
        ),
      title: TitleEditSchema.optional().describe(
        "Change a Cutroom title's look or motion; omitted fields keep their values. Refused for clips that are not titles.",
      ),
      enabled: z
        .boolean()
        .optional()
        .describe("False hides the clip from preview and render"),
    })
    .describe("Change clip properties. Null clears a property."),
  z
    .object({
      type: z.literal("setTiming"),
      clipId,
      playbackRate: z
        .number()
        .min(MIN_PLAYBACK_RATE)
        .max(MAX_PLAYBACK_RATE)
        .overwrite((value) => Math.round(value * 1e6) / 1e6)
        .optional(),
      mediaStart: z.number().nonnegative().optional(),
    })
    .describe(
      "Set media speed or source in on a clip and its linked partners, keeping timeline duration. Source in is seconds. Refuses non-media clips or insufficient source media.",
    ),
  z
    .object({
      type: z.literal("setTrack"),
      index: frame,
      name: z.string().max(200).nullable().optional(),
      locked: z.boolean().optional(),
      autoSelect: z.boolean().optional(),
      kind: z.enum(["video", "audio"]).optional(),
      enabled: z.boolean().optional(),
      muted: z.boolean().optional(),
      solo: z.boolean().optional(),
    })
    .describe(
      "Create a track or change its name, lock, auto-select, enable, mute or solo. Mute covers all sound on the track, including embedded video audio. Solo selects audio tracks and affects preview and export.",
    ),
  z
    .object({
      type: z.literal("removeTrack"),
      index: frame,
    })
    .describe(
      "Remove an unlocked empty track. Refuses occupied tracks; remove their clips first. Other track indices stay unchanged. Undo restores the track and its settings.",
    ),
  z
    .object({
      type: z.literal("setMarker"),
      id: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Omit to add a marker"),
      frame: frame.optional().describe("Required for a new marker"),
      duration: frame.optional(),
      name: label.optional(),
      note: z.string().max(20_000).optional(),
      color: MarkerColorSchema.optional().describe(
        "Ruler palette: blue/cyan = grey, green = green, purple = violet, pink/red = rose, yellow = sand",
      ),
    })
    .describe(
      "Add a marker, or change the given fields of an existing one; fields you omit keep their values. A new marker defaults to no duration, no name or note, and blue.",
    ),
  z.object({ type: z.literal("removeMarker"), id: z.string().min(1) }),
  z
    .object({
      type: z.literal("setRange"),
      in: frame.nullable().optional(),
      out: frame.nullable().optional(),
    })
    .describe("Set or clear (null) the in and out points. Out is exclusive."),
]);

export const CommandBatchSchema = z.object({
  noteId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The claimed review note this edit addresses; required when several notes are claimed",
    ),
  composition: z.string().min(1).default("index.html"),
  commands: z.array(CommandSchema).min(1).max(1_000),
  expectedRevision: z
    .string()
    .min(1)
    .describe(
      "Revision from the last timeline read; stale revisions are refused",
    ),
  label: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "Optional edit label, limited to 120 characters. Agent labels are shown as attributed text alongside the factual summary derived from the commands.",
    ),
});

export const ClipEditSchema = z.object({
  id: z.string(),
  clipId: z.string().nullable(),
  composition: z.string(),
  label: z.string(),
  by: z.enum(["human", "agent"]),
  agentName: z.string().optional(),
  at: z.string(),
  accepted: z.boolean(),
  historyId: z.string().optional(),
  resolution: z.enum(["owner", "source"]).optional(),
});

export const TAB_ORIGIN_HEADER = "x-cutroom-tab-origin";
/** On a command batch's answer: what the edit did, naming its clips, URI-encoded. */
export const EDIT_SUMMARY_HEADER = "x-cutroom-edit-summary";
export const TabOriginSchema = z.uuid();

export const AnimationLeftBehindSchema = z.object({
  clipId,
  label: z.string(),
});
export type AnimationLeftBehind = z.infer<typeof AnimationLeftBehindSchema>;
export const AnimationFeedbackSchema = z.object({
  origin: TabOriginSchema.nullable(),
  revision: z.string().min(1),
  composition: z.string(),
  clips: z.array(AnimationLeftBehindSchema),
});

export type AnimationFeedback = z.infer<typeof AnimationFeedbackSchema>;

export const TimelineViewSchema = z.object({
  skippedClips: z
    .array(z.object({ clipId, label: label.nullable(), reason: z.string() }))
    .optional(),
  agentChanges: z.array(z.string()).optional(),
  clipEdits: z.array(ClipEditSchema).optional(),
  composition: z.string(),
  revision: z.string(),
  timeline: TimelineSchema,
});

const seconds = z.number().nonnegative();

/** Timeline state HTML cannot hold, stored per composition in `cutroom.json`. Times are seconds. */
export const TimelineSettingsSchema = z.object({
  tracks: z.array(TrackSchema),
  markers: z.array(
    MarkerSchema.omit({ frame: true, duration: true }).extend({
      time: seconds,
      duration: seconds,
    }),
  ),
  range: z.object({ in: seconds.nullable(), out: seconds.nullable() }),
});

export type Fps = z.infer<typeof FpsSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type ClipKind = z.infer<typeof ClipKindSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type InsertClip = z.infer<typeof InsertClipSchema>;
export type InsertTitle = z.infer<typeof InsertTitleSchema>;
export type Title = z.infer<typeof TitleSchema>;
export type TitleEdit = z.infer<typeof TitleEditSchema>;
export type Command = z.infer<typeof CommandSchema>;
export type CommandInput = z.input<typeof CommandSchema>;
export type CommandBatch = z.infer<typeof CommandBatchSchema>;
export type TimelineView = z.infer<typeof TimelineViewSchema>;
export type TimelineSettings = z.infer<typeof TimelineSettingsSchema>;

export const emptyTimelineSettings = (): TimelineSettings => ({
  tracks: [],
  markers: [],
  range: { in: null, out: null },
});

/** Voiceover keeps its own identity while using the audio editing and rendering path. */
export const isAudioKind = (kind: ClipKind) =>
  kind === "audio" || kind === "voiceover";
