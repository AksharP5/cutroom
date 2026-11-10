import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import { z } from "zod";

const frame = z.number().int().nonnegative();
const frames = z.number().int().positive();
const clipId = z.string().min(1).max(200);
const label = z.string().max(500);
/** Static gain as written to `data-volume`: 0 is silence, 3.98 is +12 dB. */
const volume = z.number().min(0).max(3.98);
/** Static CSS values are canonical to six decimals, beyond CSS parser float precision. */
const opacity = z
  .number()
  .min(0)
  .max(1)
  .overwrite((value) => Math.round(value * 1e6) / 1e6);

export const FpsSchema = z.object({
  num: z.number().int().positive(),
  den: z.number().int().positive(),
});

export const ClipKindSchema = z.enum([
  "video",
  "audio",
  "image",
  "composition",
  "element",
]);

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
  volume: z.number().nonnegative().nullable(),
  /** Static inline opacity; null leaves the authored stylesheet in control. */
  opacity: opacity.nullable(),
  /** False while `data-hidden` keeps the clip out of preview and render. */
  enabled: z.boolean(),
  /** Set while `data-start` names another clip and still resolves to `start`. */
  startRef: z.object({ clipId, offset: z.number().int() }).nullable(),
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
  kind: z.enum(["video", "audio", "image"]),
  src: z.string().min(1).max(2_000).describe("Project-relative media path"),
  duration: frames.describe("Length on the timeline in frames"),
  mediaStart: z
    .number()
    .nonnegative()
    .default(0)
    .overwrite((seconds) => Math.round(seconds * 1e6) / 1e6)
    .describe(
      "Seconds into the source where the clip begins, to the microsecond",
    ),
  label: label.optional(),
  volume: volume.optional(),
  muted: z.boolean().default(false).describe("Video only: drop its sound"),
});

const clipIds = z.array(clipId).min(1).max(10_000);
/** Ids for the pieces a command cuts off, so a caller knows a new clip's id before it exists. */
const pieceIds = z
  .record(clipId, z.array(clipId).min(1).max(10_000))
  .optional()
  .describe(
    "Ids for the pieces this command cuts off, keyed by the id of the clip they are cut from, in the order the command cuts them. A ripple through several ranges cuts a spanning clip once per range, last range first. Each id must never have been used in this project, even by a clip that was deleted or undone; any other id is refused with duplicate_id. Pieces without one get a new random id.",
  );

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
          "place refuses overlaps, overwrite replaces the range on the track, insert splits and shifts unlocked auto-select tracks",
        ),
      track: frame,
      at: frame,
      clip: InsertClipSchema,
      linkedAudio: z
        .object({ id: clipId.optional() })
        .optional()
        .describe(
          "Optional id for video's linked audio clip. Video inserts split sound onto the first free unlocked audio track by default, creating a track if needed. Silent sources and clip.muted=true stay video-only.",
        ),
      ids: pieceIds,
    })
    .describe("Add a media clip."),
  z
    .object({
      type: z.literal("setClip"),
      clipId,
      label: label.nullable().optional(),
      volume: volume.nullable().optional(),
      opacity: opacity.nullable().optional(),
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
      type: z.literal("setMarker"),
      id: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Omit to add a marker"),
      frame,
      duration: frame.default(0),
      name: label.default(""),
      note: z.string().max(20_000).default(""),
      color: MarkerColorSchema.default("blue"),
    })
    .describe("Add or replace a timeline marker."),
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
  label: z.string().trim().min(1).max(120).default("Edit timeline"),
});

export const ClipEditSchema = z.object({
  id: z.string(),
  clipId: z.string(),
  composition: z.string(),
  label: z.string(),
  by: z.enum(["human", "agent"]),
  at: z.string(),
  accepted: z.boolean(),
});

export const TimelineViewSchema = z.object({
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
