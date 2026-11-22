import {
  defaultFormat,
  pictureSizeRule,
  ProjectFormatSchema,
  withinPictureArea,
} from "./projectFormat";
import { z } from "zod";
import { TimelineSettingsSchema } from "./timeline/schema";
import { JobStateSchema } from "./jobs";

export const PROJECT_DOCUMENT_PATH = "cutroom.json";

export const PointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export const StrokeSchema = z.object({
  points: z.array(PointSchema).min(1).max(10_000),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .default("#df764c"),
});
const annotationFields = {
  kind: z.enum(["comment", "drawing"]),
  compositionPath: z.string(),
  framePath: z.string().optional(),
  body: z.string().max(20_000),
  time: z.number().finite().nonnegative(),
  endTime: z.number().finite().nonnegative().optional(),
  elementId: z.string().max(200).optional(),
  point: PointSchema.optional(),
  strokes: z.array(StrokeSchema).max(100),
};
export const AnnotationInputSchema = z.object({
  id: z.uuid().optional(),
  ...annotationFields,
  compositionPath: annotationFields.compositionPath.default("index.html"),
  body: annotationFields.body.default(""),
  strokes: annotationFields.strokes.default([]),
});
export const AnnotationSchema = AnnotationInputSchema.extend({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Status saved before review state moved to `.cutroom/review.json`. Read only to migrate it. */
  status: z.enum(["open", "sent", "resolved"]).optional(),
});
export const AnnotationPatchSchema = z.object(annotationFields).partial();
export const WordSchema = z
  .object({
    id: z.string().min(1).max(200),
    text: z.string().min(1).max(2_000),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
  })
  .refine((word) => word.end > word.start, "Word end must follow its start");

const ClipOriginalSchema = z.object({
  html: z.string(),
  start: z.number(),
  duration: z.number().positive(),
  mediaStart: z.number().nonnegative(),
  playbackRate: z.number().positive(),
});
export const TranscriptSchema = z.object({
  id: z.string(),
  mediaPath: z.string(),
  sourceFile: z.string(),
  elementId: z.string(),
  language: z.string(),
  words: z.array(WordSchema),
  cutWordIds: z.array(z.string()),
  createdAt: z.string(),
  original: ClipOriginalSchema,
});
export const TranscriptViewSchema = TranscriptSchema.extend({
  words: z.array(
    WordSchema.extend({
      cut: z.boolean(),
      timelineStart: z.number().nullable(),
      /** Where the word stops on the timeline; null with `timelineStart`. */
      timelineEnd: z.number().nullable(),
    }),
  ),
  duration: z.number().nonnegative(),
});
const LegacyDocumentSchema = z.looseObject({ schemaVersion: z.literal(1) });
/** Version 2 adds per-composition timeline settings. Older documents migrate on read. */
export const ProjectDocumentSchema = z.preprocess(
  (value) => {
    const legacy = LegacyDocumentSchema.safeParse(value);
    return legacy.success
      ? { ...legacy.data, schemaVersion: 2, timelines: {} }
      : value;
  },
  z.object({
    schemaVersion: z.literal(2),
    annotations: z.array(AnnotationSchema),
    transcripts: z.array(TranscriptSchema),
    timelines: z.record(z.string(), TimelineSettingsSchema),
  }),
);
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** What home shows beside the registry entry, read from the project's root composition. */
export const ProjectSummarySchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  /** Seconds. */
  duration: z.number().nonnegative(),
});
/** A project's display name: one line of text, shown on Home, in the header and in export names. */
/** Control characters and bidirectional overrides would hide or reorder what a name shows. */
const showsAsWritten = (name: string) =>
  !/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(name);
export const ProjectNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a project name.")
  .max(120, "Keep the project name to 120 characters.")
  .refine(showsAsWritten, "A project name cannot contain control characters.");
/** A timeline's file name, before a copy number and `.html`, stays within 255 bytes. */
export const TIMELINE_NAME_BYTES = 200;
export const TimelineNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a timeline name.")
  .refine(showsAsWritten, "A timeline name cannot contain control characters.")
  .refine(
    (name) => new TextEncoder().encode(name).length <= TIMELINE_NAME_BYTES,
    `Keep the timeline name to ${TIMELINE_NAME_BYTES} bytes, so its file name fits.`,
  );
/** How long a new project, and a new timeline in one, lasts until it is changed, in seconds. */
export const NEW_PROJECT_SECONDS = 12;
export const CreateProjectSchema = z
  .object({
    name: ProjectNameSchema,
    width: ProjectFormatSchema.shape.width.default(defaultFormat.width),
    height: ProjectFormatSchema.shape.height.default(defaultFormat.height),
    fps: ProjectFormatSchema.shape.fps.default(defaultFormat.fps),
    duration: z
      .number()
      .finite()
      .min(1)
      .max(86_400)
      .default(NEW_PROJECT_SECONDS),
  })
  .refine(withinPictureArea, pictureSizeRule);
export const DuplicateTimelineSchema = z.object({
  composition: z
    .string()
    .min(1)
    .default("index.html")
    .describe("The timeline to copy, a root-level .html file"),
  name: TimelineNameSchema.optional().describe(
    'Name of the copy, without .html. Defaults to "<name> copy"; a taken name gets a number',
  ),
});
export const RenameTimelineSchema = z.object({
  composition: z
    .string()
    .min(1)
    .describe(
      "The timeline to rename, a root-level .html file other than index.html",
    ),
  name: TimelineNameSchema.describe("The timeline's new name, without .html"),
});
export const NewTimelineSchema = z.object({
  name: TimelineNameSchema.optional().describe(
    'Name of the new timeline, without .html. Defaults to "Timeline 2", "Timeline 3" and so on; a taken name gets a number',
  ),
});
export const ImportProjectSchema = z.object({
  path: z.string().min(1),
  name: ProjectNameSchema.optional(),
});
export const RenameProjectSchema = z.object({ name: ProjectNameSchema });
/** A project being copied beside its original. `projectId` names the copy once it is on the list. */
export const DuplicateJobSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  name: z.string(),
  state: JobStateSchema,
  projectId: z.string().optional(),
});
export type DuplicateJob = z.infer<typeof DuplicateJobSchema>;
export const TranscriptImportSchema = z.object({
  mediaPath: z.string().min(1),
  sourceFile: z.string().default("index.html"),
  elementId: z.string().min(1),
  language: z.string().default("en"),
  words: z.array(WordSchema).min(1).max(200_000),
});
export const CutWordsSchema = z.object({
  noteId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The claimed review note this edit addresses; required when several notes are claimed",
    ),
  wordIds: z.array(z.string()).min(1).max(200_000),
  action: z.enum(["cut", "restore"]),
  expectedVersion: z.string().optional(),
});
export const TranscribeInputSchema = TranscriptImportSchema.omit({
  words: true,
});
export const SourceSchema = z.object({
  path: z.string(),
  content: z.string(),
  version: z.string(),
});
export const SourceWriteSchema = z.object({
  noteId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The claimed review note this edit addresses; required when several notes are claimed",
    ),
  path: z.string().default("index.html"),
  content: z.string().max(10 * 1024 * 1024),
  expectedVersion: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "Exact version from source_read, or null to create a new file without overwriting",
    ),
});
export const TranscriptJobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.enum(["running", "complete", "failed", "cancelled"]),
  message: z.string(),
  progress: z.number(),
  transcriptId: z.string().optional(),
  error: z.string().optional(),
});
export const MediaClipSchema = z.object({
  elementId: z.string(),
  mediaPath: z.string(),
  sourceFile: z.string(),
  label: z.string(),
  kind: z.enum(["video", "audio"]),
  start: z.number(),
  duration: z.number(),
  /**
   * The editing proxy the preview plays for a video the browser cannot decode, such as HEVC or
   * ProRes. Absent for a video that plays as it is.
   */
  proxy: JobStateSchema.optional(),
});
export const MediaListSchema = z.object({ media: z.array(MediaClipSchema) });

export type Point = z.infer<typeof PointSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type AnnotationInput = z.input<typeof AnnotationInputSchema>;
export type TranscriptWord = z.infer<typeof WordSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type TranscriptView = z.infer<typeof TranscriptViewSchema>;
export type ProjectDocument = z.infer<typeof ProjectDocumentSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type CreateProjectInput = z.input<typeof CreateProjectSchema>;
export type TranscriptImport = z.infer<typeof TranscriptImportSchema>;
export type CutWords = z.infer<typeof CutWordsSchema>;
export type TranscriptJob = z.infer<typeof TranscriptJobSchema>;
export type MediaClip = z.infer<typeof MediaClipSchema>;

export const emptyProjectDocument = (): ProjectDocument => ({
  schemaVersion: 2,
  annotations: [],
  transcripts: [],
  timelines: {},
});
