import { z } from "zod";

/** Looks a caption composition can take. Each is one stylesheet in the captions file. */
export const CAPTION_STYLES = ["karaoke", "highlight", "plain"] as const;
export const CaptionStyleSchema = z
  .enum(CAPTION_STYLES)
  .describe(
    "karaoke: words light up as they are spoken; highlight: the spoken word gets a colour block; plain: the whole line at once",
  );
export const CAPTION_STYLE_LABELS: Record<CaptionStyle, string> = {
  karaoke: "Karaoke",
  highlight: "Word highlight",
  plain: "Plain",
};

export const SubtitleFormatSchema = z.enum(["srt", "vtt"]);

/** Caption text is plain words on one line; markup in it is shown as written, never parsed. */
export const captionText = (text: string) => text.replace(/\s+/g, " ").trim();

const seconds = z.number().finite().nonnegative();
/** A caption word: the transcript word it came from, its shown text, and when it is spoken. */
export const CaptionWordSchema = z.object({
  id: z.string().min(1).max(200),
  text: z.string().min(1).max(2_000),
  /** Seconds from the start of the captions clip. */
  start: seconds,
});
/** One line on screen, shown over `[start, end)` seconds of the captions clip. */
export const CaptionGroupSchema = z
  .object({
    start: seconds,
    end: seconds,
    words: z.array(CaptionWordSchema).min(1).max(100),
  })
  .refine(
    (group) => group.end > group.start,
    "A caption must end after it starts.",
  );
export const CaptionsSchema = z.object({
  style: CaptionStyleSchema,
  transcriptId: z.string().min(1).max(200),
  groups: z.array(CaptionGroupSchema).max(50_000),
});

/** What the editor and agents read about one transcript's captions. */
export const CaptionsViewSchema = z.object({
  transcriptId: z.string(),
  /** The composition the captions clip is on. */
  sourceFile: z.string(),
  /** The captions composition file. */
  file: z.string(),
  clipId: z.string(),
  style: CaptionStyleSchema,
  /** True when the transcript's timing or cuts changed since the captions were written. */
  stale: z.boolean(),
  /** Lines in the composition's time, in seconds, as an SRT export writes them. */
  cues: z.array(
    z.object({ start: z.number(), end: z.number(), text: z.string() }),
  ),
  /** Caption words whose text differs from the transcript, by word id. Regeneration keeps them. */
  edits: z.record(z.string(), z.string()),
});

const noteId = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The claimed review note this edit addresses; required when several notes are claimed",
  );
const transcriptId = z
  .string()
  .min(1)
  .describe("Transcript ID from transcripts_list");
export const CaptionsEditSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("generate"),
      transcriptId,
      style: CaptionStyleSchema.optional().describe(
        "Defaults to the captions' current style, or karaoke for new captions",
      ),
      noteId,
    })
    .describe(
      "Write the transcript's captions as one captions clip on its own track, or rewrite existing ones to follow the transcript's current timing and cuts. Edited words keep their text.",
    ),
  z
    .object({
      action: z.literal("style"),
      transcriptId,
      style: CaptionStyleSchema,
      noteId,
    })
    .describe("Change existing captions' look; words and timing stay."),
  z
    .object({
      action: z.literal("word"),
      transcriptId,
      wordId: z.string().min(1).max(200),
      text: z
        .string()
        .max(200)
        .overwrite(captionText)
        .refine((text) => text.length > 0, "A caption word cannot be empty.")
        .describe(
          "The word as captions show it. The transcript keeps its own text; regenerating keeps this edit",
        ),
      noteId,
    })
    .describe("Change one caption word's text."),
]);

/** Limits that keep an imported subtitle file within what an editor session can hold. */
export const SUBTITLE_LIMITS = {
  bytes: 2 * 1024 * 1024,
  cues: 20_000,
  /** Characters of text in one cue. */
  cueText: 2_000,
  /** The longest timestamp, as long as the longest project. */
  seconds: 86_400,
} as const;

export const SubtitleImportSchema = z.object({
  mediaPath: z.string().min(1),
  sourceFile: z.string().default("index.html"),
  elementId: z.string().min(1),
  language: z.string().default("en"),
  format: SubtitleFormatSchema,
  text: z
    .string()
    .max(SUBTITLE_LIMITS.bytes, "Subtitle files can be up to 2 MB.")
    .describe(
      "The whole SRT or WebVTT file. Times are seconds into the media file",
    ),
});

export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;
export type CaptionWord = z.infer<typeof CaptionWordSchema>;
export type CaptionGroup = z.infer<typeof CaptionGroupSchema>;
export type Captions = z.infer<typeof CaptionsSchema>;
export type CaptionsView = z.infer<typeof CaptionsViewSchema>;
export type CaptionsEdit = z.infer<typeof CaptionsEditSchema>;
export type SubtitleFormat = z.infer<typeof SubtitleFormatSchema>;
export type SubtitleImport = z.infer<typeof SubtitleImportSchema>;
