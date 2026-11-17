import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import { MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import { MAX_AUTOMATION_POINTS } from "@hyperframes/core/audio-automation";
// The export worker loads this file in Node, which needs the extension.
import { FxChainInputSchema, FxNodeSchema, MAX_FX_NODES } from "./fx.ts";
import {
  ElementStyleEditSchema,
  ElementStyleSchema,
  fontFamily,
} from "./elementStyle.ts";
import { z } from "zod";

const frame = z.number().int().nonnegative();
const frames = z.number().int().positive();
const clipId = z.string().min(1).max(200);
const label = z.string().max(500);
/** Static gain as written to `data-volume`: 0 is silence, MAX_AUDIO_GAIN is +12 dB. */
const volume = z
  .number()
  .min(0)
  .max(MAX_AUDIO_GAIN, "Gain goes up to +12 dB per stage.");
/** A clip-local volume point, as `setClip.automation` writes it and `timeline_read` shows it. */
export const VolumePointSchema = z.object({
  frame: z
    .number()
    .nonnegative()
    .describe("Clip-local frame, 0 is the clip's first; fractions are allowed"),
  gain: volume.describe(
    "Linear gain on top of the clip's own: 1 = no change, 0.5 = -6 dB, 0 = silence, up to +12 dB",
  ),
});

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
    "Additive offset in composition CSS pixels, not a coordinate; null or zero clears it",
  );

/** Canonical at the given decimals, which survive the CSS parser's 32-bit floats exactly. */
const canonical = (decimals: number) => (value: number) =>
  Number(value.toFixed(decimals)) + 0;
/** A static inline `scale` axis: 1 is the clip's own size. */
const scale = z.number().min(0.01).max(100).overwrite(canonical(4));
/** A static inline `rotate` in degrees, clockwise. */
const rotation = z.number().min(-3600).max(3600).overwrite(canonical(2));
/** Pixels trimmed from one edge of the clip's own box, before scale and rotation. */
const cropEdge = z.number().min(0).max(20000).overwrite(canonical(2));
export const CropSchema = z.object({
  top: cropEdge,
  right: cropEdge,
  bottom: cropEdge,
  left: cropEdge,
});

export const KEYFRAME_PROPERTIES = [
  "position",
  "scale",
  "rotation",
  "crop",
  "opacity",
] as const;
export const KEYFRAME_EASES = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "hold",
] as const;
/** A clip-local frame: 0 is the clip's first frame. Trims can leave keyframes outside the clip. */
const keyframeFrame = z.number().int().min(-1_000_000).max(1_000_000);
/** Keyframed position offsets are bounded so every generated CSS length stays exact. */
const offset = z
  .number()
  .min(-100_000)
  .max(100_000)
  .overwrite((value) => Number(value.toFixed(6)) + 0);
/** The value a keyframe holds for each property, in the static fields' units and precision. */
export const KeyframeValueSchemas = {
  position: z.object({ x: offset, y: offset }),
  scale: z.object({ x: scale, y: scale }),
  rotation,
  crop: CropSchema,
  opacity,
} as const;
const track = <T extends z.ZodType>(value: T) =>
  z
    .array(
      z.object({
        frame: keyframeFrame,
        value,
        ease: z.enum(KEYFRAME_EASES),
      }),
    )
    .min(1)
    .max(1_000)
    .refine(
      (keyframes) =>
        keyframes.every(
          (keyframe, index) =>
            index === 0 || keyframe.frame > keyframes[index - 1]!.frame,
        ),
      "Keyframes are in frame order, one per frame.",
    );
/**
 * Animated properties, each a list of keyframes in frame order. A property listed here has no
 * static value: its static field is null while it has keyframes.
 */
export const KeyframesSchema = z
  .object({
    position: track(KeyframeValueSchemas.position),
    scale: track(KeyframeValueSchemas.scale),
    rotation: track(KeyframeValueSchemas.rotation),
    crop: track(KeyframeValueSchemas.crop),
    opacity: track(KeyframeValueSchemas.opacity),
  })
  .partial();

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
export const TRANSITION_KINDS = ["dissolve", "dip"] as const;
export const TRANSITION_ALIGNMENTS = ["center", "start", "end"] as const;
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
  font: fontFamily
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
  shadow: z
    .object({
      color: titleColor(8),
      blur: z
        .number()
        .int()
        .min(0)
        .max(200)
        .describe("Blur radius in composition pixels"),
    })
    .nullable()
    .describe(
      "Drop shadow under the words, colour with alpha; null for none. Set as a whole object.",
    ),
  stroke: z
    .object({
      color: titleColor(6),
      width: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe("Thickness outside the letters in composition pixels"),
    })
    .nullable()
    .describe(
      "Outline around the letters; null for none. Set as a whole object.",
    ),
  in: titleMotion.describe("Entrance, anchored to the clip's first frame"),
  out: titleMotion.describe("Exit, ending on the clip's last frame"),
});

/**
 * A transition across a cut, stored on both clips' edges. The outgoing clip's media runs on past
 * the cut and the incoming clip's starts before it, so both play while the transition runs.
 */
export const TransitionSchema = z.object({
  kind: z
    .enum(TRANSITION_KINDS)
    .describe(
      "dissolve mixes the pictures; dip fades to black and back. Sound always crossfades",
    ),
  duration: frames.max(100_000).describe("Length in frames"),
  alignment: z
    .enum(TRANSITION_ALIGNMENTS)
    .describe(
      "center straddles the cut; start begins on it; end finishes on it",
    ),
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
  authoredAudioGroupId: z
    .string()
    .optional()
    .describe(
      "Authored audio bus referenced by the clip, even without a matching declaration in timeline.authoredAudioGroups",
    ),
  trackGainWarning: z
    .string()
    .optional()
    .describe(
      "When present, track gain does not apply to this clip. Its authored audio group is preserved.",
    ),
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
  scaleX: scale
    .nullable()
    .default(null)
    .describe(
      "Static scale, 1 = the clip's own size; null with scaleY when unset",
    ),
  scaleY: scale.nullable().default(null),
  rotation: rotation
    .nullable()
    .default(null)
    .describe("Static clockwise rotation in degrees about the clip's centre"),
  crop: CropSchema.nullable()
    .default(null)
    .describe(
      "Pixels cut from each edge of the clip's own box. It does not change layout",
    ),
  keyframes: KeyframesSchema.nullable()
    .default(null)
    .describe(
      "Animated position, scale, rotation, crop and opacity: per property, keyframes {frame, value, ease} in clip-local frames (0 is the clip's first frame), in the same units as the static fields, which are null while their property has keyframes. Before the first keyframe the property holds its value, and after the last. ease shapes the motion from that keyframe to the next: linear, ease-in, ease-out, ease-in-out, or hold, which keeps the value until the next keyframe. Keyframes travel with the clip through moves and trims; a trimmed clip can keep keyframes outside it. null is none.",
    ),
  text: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "The words of a text element, with line breaks at <br> and preserved source newlines; null for media and elements without text. setClip.text replaces them unless sourceRestrictions.text says why it cannot.",
    ),
  variableBindings: z
    .object({
      text: z.string().optional(),
      color: z.string().optional(),
    })
    .optional()
    .describe(
      "Authored text and inline colour variable ids, read from the source",
    ),
  title: TitleSchema.nullable()
    .default(null)
    .describe(
      "A Cutroom title's look and motion; null for every other clip. Change it with setClip.title and its words with setClip.text.",
    ),
  style: ElementStyleSchema.default({}).describe(
    "The clip's inline look, as setClip.style writes it: text style on text elements, fill, corner radius, shadow, blur, layout size, and fit on video and images. A field is left out when the clip sets no inline value Cutroom can read; the composition's stylesheets and animation then decide it.",
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
  transitionIn: TransitionSchema.nullable()
    .default(null)
    .describe(
      "The transition from the clip ending where this one starts on its track; null for a cut",
    ),
  transitionOut: TransitionSchema.nullable()
    .default(null)
    .describe(
      "The transition to the clip starting where this one ends; the same value as that clip's transitionIn",
    ),
  /** HyperFrames clip-local automation, stored in its native attribute format. */
  automation: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "HyperFrames clip-local automation JSON, which may contain baked volume ramps",
    ),
  fx: z
    .array(FxNodeSchema)
    .max(MAX_FX_NODES)
    .default([])
    .describe(
      "Audio effects on the clip's sound, in signal order, from HyperFrames' data-fx-chain. enabled false is bypassed. Change them with setClip.fx",
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
      fx: z.string().optional(),
      transform: z.string().optional(),
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
  volume: volume
    .default(1)
    .describe(
      "Linear track gain on top of each clip's gain: 0 is silence, 1 = 0 dB. Independent group stage, up to +12 dB per stage; authored-group clips are excluded and carry trackGainWarning",
    ),
  fx: z
    .array(FxNodeSchema)
    .max(MAX_FX_NODES)
    .default([])
    .describe(
      "Audio effects on the track's bus, after its clips' own effects and before its gain. Excludes clips with trackGainWarning",
    ),
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
  authoredAudioGroups: z
    .array(
      z.object({
        id: z.string(),
        volume: z.number(),
        sourceRestriction: z.string().optional(),
      }),
    )
    .optional()
    .describe(
      "Authored audio bus declarations in this composition, including empty groups. Each volume is linear gain. sourceRestriction explains why its gain cannot be edited with setAudioGroup",
    ),
  masterFx: z
    .array(FxNodeSchema)
    .max(MAX_FX_NODES)
    .optional()
    .describe(
      "Audio effects on the whole mix, the composition root's master bus, after every track. Omitted when it has none. Change them with setMaster",
    ),
  /** Projected by the parser from the project's `@font-face` rules, never written back. */
  fonts: z
    .array(z.string())
    .optional()
    .describe(
      "Font families the project declares; a title's font is one of these or null. Omitted when it declares none.",
    ),
});

export const InsertClipSchema = z.object({
  id: clipId
    .optional()
    .describe(
      "Element id, never used before in this project; when omitted, the file name and a random suffix",
    ),
  kind: z.enum(["video", "audio", "voiceover", "image"]),
  src: z
    .string()
    .min(1)
    .max(2_000)
    .describe(
      "Media path as the composition writes it, from the composition file's folder: media/talk.mp4 in index.html, ../media/talk.mp4 in compositions/scene.html",
    ),
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

export const InsertCompositionSchema = z.object({
  id: clipId
    .optional()
    .describe(
      "Host element id, never used before in this project; when omitted, the file name and a random suffix",
    ),
  kind: z.literal("composition"),
  src: z
    .string()
    .min(1)
    .max(2_000)
    .describe(
      "The sub-composition's HTML file as this composition writes it, from its folder: compositions/intro.html in index.html",
    ),
  duration: frames.describe(
    "Length on the timeline in frames, usually the composition's own length from timeline_read",
  ),
  label: label.optional(),
});

const clipIds = z.array(clipId).min(1).max(10_000);
/** Ids for the pieces a command cuts off, so a caller knows a new clip's id before it exists. */
const pieceIds = z
  .record(clipId, z.array(clipId).min(1).max(10_000))
  .optional()
  .describe(
    "New ids for the pieces this command cuts off, keyed by source clip id in cut order; unnamed pieces get random ids",
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
      type: z.literal("closeGap"),
      track: frame,
      at: frame.describe("Any frame inside the gap"),
    })
    .describe(
      "Close the empty gap between clips on a track, as selecting it and pressing Delete does: everything after it moves earlier by its length on this track and every unlocked auto-select track. Refused when a clip on one of those tracks is in the gap's time, naming it; turning off auto-select on its track closes the gap without it. The space after a track's last clip is not a gap.",
    ),
  z
    .object({
      type: z.literal("slip"),
      clipId,
      by: z
        .number()
        .int()
        .describe(
          "Frames to move the clip's source in and out points; positive shows later source material",
        ),
      linked: z
        .boolean()
        .default(true)
        .describe(
          "False slips only this clip, leaving its linked partners' sources where they are, which puts them out of sync",
        ),
    })
    .describe(
      "Slip a video, audio or composition clip: it shows an earlier or later part of its source in the same place and length. Linked partners slip with it. Keyframes and volume points move with the content they animate, as in a trim. Refused past either end of the source or past a transition's media, saying how far it can go.",
    ),
  z
    .object({
      type: z.literal("slide"),
      clipIds: clipIds.describe(
        "The clips to slide; their linked partners come too. Clips next to each other on a track slide as one block",
      ),
      by: z
        .number()
        .int()
        .describe("Frames to move the clips; negative is earlier"),
    })
    .describe(
      "Slide clips between their neighbours: they move as one block, keeping their source in and out, while the clip that ends where the block starts and the clip that starts where it ends trim to follow, with those neighbours' linked partners, so nothing else moves. A gap beside the block shrinks or grows instead of a neighbour. Refused when a neighbour or its partner would run out of source or below one frame, a clip would cover another, or a transition on a changed cut would no longer fit, saying how far it can go; and when a clip that is not named sits between named ones.",
    ),
  z
    .object({
      type: z.literal("link"),
      clipIds: z.array(clipId).min(2).max(10_000),
    })
    .describe(
      "Link two or more different clips so they select, move, trim and cut as one, as a video and its sound are. Partners of clips already linked join the new group.",
    ),
  z
    .object({
      type: z.literal("unlink"),
      clipIds,
    })
    .describe(
      "Unlink clips from their partners so each edits alone. A partner left on its own is unlinked too.",
    ),
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
      clip: z.discriminatedUnion("kind", [
        InsertClipSchema,
        InsertTitleSchema,
        InsertCompositionSchema,
      ]),
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
      'Add a media clip; a title with clip.kind "title": words on screen with a preset entrance and exit that stay on the clip\'s edges through every edit; or a scene with clip.kind "composition": a host clip that plays another composition file of the project from its start.',
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
        .object({
          volume: z
            .array(VolumePointSchema)
            .max(MAX_AUTOMATION_POINTS)
            .describe(
              "The whole volume envelope, in straight runs between points; the first point's gain holds before it and the last one's after it. [] removes the envelope",
            ),
        })
        .nullable()
        .optional()
        .describe(
          "Volume automation on a clip with sound, on top of its gain and fades. Replaces the volume envelope and keeps effect lanes; null clears every lane, including baked volume ramps",
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
      fx: FxChainInputSchema.optional().describe(
        "Replace the clip's audio effects, in signal order. Each entry is an effect {type, params, enabled, id} or a preset {preset}; an entry naming an existing id keeps the values it leaves out. [] removes them",
      ),
      opacity: opacity.nullable().optional(),
      x: position.optional(),
      y: position.optional(),
      scale: scale
        .nullable()
        .optional()
        .describe("Both scale axes; 1 or null resets"),
      scaleX: scale.nullable().optional(),
      scaleY: scale.nullable().optional(),
      rotation: rotation
        .nullable()
        .optional()
        .describe("Degrees clockwise; 0 or null resets"),
      crop: CropSchema.partial()
        .nullable()
        .optional()
        .describe(
          "Pixels per edge; omitted edges keep their values, null clears",
        ),
      text: titleText
        .optional()
        .describe(
          "Replace a text element's words. Newlines become <br>; other whitespace collapses as HTML renders it. Refused for media, elements without text, and nested markup, uncertain multiline whitespace, or certain script writes by id. Other scripts can replace the saved words. Verify with timeline_view frames.",
        ),
      title: TitleEditSchema.optional().describe(
        "Change a Cutroom title's look or motion; omitted fields keep their values. Refused for clips that are not titles.",
      ),
      style: ElementStyleEditSchema.optional().describe(
        "Restyle any visual clip that is not a Cutroom title, written as inline CSS on its element: omitted fields keep their values, null removes one and hands it back to the composition's stylesheets. Text fields need an element clip, objectFit a video or image. Inline style draws over stylesheets but not over the composition's own animation of the same property.",
      ),
      enabled: z
        .boolean()
        .optional()
        .describe("False hides the clip from preview and render"),
    })
    .describe("Change clip properties. Null clears a property."),
  z
    .object({
      type: z.literal("setKeyframe"),
      clipId,
      property: z.enum(KEYFRAME_PROPERTIES),
      frame: keyframeFrame.describe(
        "Clip-local frame, 0 is the clip's first frame; inside the clip",
      ),
      value: z
        .union([
          z.number(),
          z.object({ x: z.number().optional(), y: z.number().optional() }),
          CropSchema.partial(),
        ])
        .optional()
        .describe(
          "position and scale take {x, y}; crop takes {top, right, bottom, left}; rotation and opacity take a number. Omitted fields, or an omitted value, keep what the clip shows at that frame",
        ),
      ease: z
        .enum(KEYFRAME_EASES)
        .optional()
        .describe(
          "The motion from this keyframe to the next; omitted keeps the keyframe's ease, linear for a new one",
        ),
    })
    .describe(
      "Add a keyframe on a clip's position, scale, rotation, crop or opacity, or change the one at that frame. The first keyframe turns the property's static value into keyframes. Keyframing scale or rotation on a clip with a static position keyframes the position too, at the same frame, so the two cannot drift.",
    ),
  z
    .object({
      type: z.literal("removeKeyframe"),
      clipId,
      property: z.enum(KEYFRAME_PROPERTIES),
      frame: keyframeFrame,
    })
    .describe(
      "Remove one keyframe. Removing a property's last keyframe leaves its value as the static value.",
    ),
  z
    .object({
      type: z.literal("moveKeyframe"),
      clipId,
      property: z.enum(KEYFRAME_PROPERTIES),
      frame: keyframeFrame,
      to: keyframeFrame.describe(
        "Clip-local frame inside the clip, without a keyframe of the same property",
      ),
    })
    .describe("Retime one keyframe, keeping its value and ease."),
  z
    .object({
      type: z.literal("setTransition"),
      from: clipId.describe("The outgoing clip, ending at the cut"),
      to: clipId.describe(
        "The incoming clip, starting at the cut on the same track",
      ),
      transition: z
        .object({
          kind: TransitionSchema.shape.kind.default("dissolve"),
          duration: TransitionSchema.shape.duration,
          alignment: TransitionSchema.shape.alignment.default("center"),
        })
        .nullable()
        .describe("null removes the transition"),
      linked: z
        .boolean()
        .default(true)
        .describe(
          "False sets only this cut, leaving linked partners' cuts as they are",
        ),
    })
    .describe(
      "Set or remove the transition on a cut between two video, image or audio clips. Linked partners meeting at the same cut get it too, unless linked is false. The outgoing clip needs media past its out point and the incoming clip before its in point; a length that does not fit is refused with the longest that does. A transition owns its audio edge fades. Trims keep it on the cut and shorten it to fit; moving a clip away or deleting one removes it.",
    ),
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
      volume: volume
        .optional()
        .describe(
          "Linear track gain, 0 for silence, 1 = 0 dB, up to +12 dB. Independent audio group stage in preview and export, up to +12 dB per stage. Clips already in an authored audio group are excluded; read trackGainWarning on each clip",
        ),
      fx: FxChainInputSchema.optional().describe(
        "Replace the track's audio effects, which process every clip on it together, as setClip.fx does for one clip",
      ),
    })
    .describe(
      "Create a track or change its name, lock, auto-select, enable, mute, solo or gain. Mute covers all sound on the track, including embedded video audio. Gain excludes clips with trackGainWarning. Solo selects audio tracks and affects preview and export.",
    ),
  z
    .object({
      type: z.literal("setAudioGroup"),
      clipId,
      volume,
    })
    .describe(
      "Set the gain of a clip's existing authored audio group. Changes every member together; refuses missing or source-restricted groups and any locked member track. Preserves routing, FX, mute and automation",
    ),
  z
    .object({
      type: z.literal("setMaster"),
      fx: FxChainInputSchema,
    })
    .describe(
      "Replace the master bus effects, which process the whole mix after every track, as setClip.fx does for one clip. Loudness normalization of the mix is a gain effect here",
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
export type Keyframes = z.infer<typeof KeyframesSchema>;
export type KeyframeProperty = (typeof KEYFRAME_PROPERTIES)[number];
export type KeyframeEase = (typeof KEYFRAME_EASES)[number];
export type ClipKind = z.infer<typeof ClipKindSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type InsertClip = z.infer<typeof InsertClipSchema>;
export type InsertTitle = z.infer<typeof InsertTitleSchema>;
export type InsertComposition = z.infer<typeof InsertCompositionSchema>;
export type Title = z.infer<typeof TitleSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
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
