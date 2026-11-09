import { z } from "zod";

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
  status: z.enum(["open", "sent", "resolved"]),
};
export const AnnotationInputSchema = z.object({
  ...annotationFields,
  compositionPath: annotationFields.compositionPath.default("index.html"),
  body: annotationFields.body.default(""),
  strokes: annotationFields.strokes.default([]),
  status: annotationFields.status.default("open"),
});
export const AnnotationSchema = AnnotationInputSchema.extend({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
    }),
  ),
  duration: z.number().nonnegative(),
});
export const ProjectDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  annotations: z.array(AnnotationSchema),
  transcripts: z.array(TranscriptSchema),
});
export const ProjectNotebookSchema = z.object({
  annotations: z.array(AnnotationSchema),
  transcriptVersion: z.string(),
});
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  width: z.number().int().min(240).max(7680).default(1920),
  height: z.number().int().min(240).max(7680).default(1080),
  duration: z.number().finite().min(1).max(86_400).default(12),
});
export const ImportProjectSchema = z.object({
  path: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
});
export const TranscriptImportSchema = z.object({
  mediaPath: z.string().min(1),
  sourceFile: z.string().default("index.html"),
  elementId: z.string().min(1),
  language: z.string().default("en"),
  words: z.array(WordSchema).min(1).max(200_000),
});
export const CutWordsSchema = z.object({
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
  path: z.string().default("index.html"),
  content: z.string().max(10 * 1024 * 1024),
  expectedVersion: z.string().min(1),
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
export type CreateProjectInput = z.input<typeof CreateProjectSchema>;
export type TranscriptImport = z.infer<typeof TranscriptImportSchema>;
export type CutWords = z.infer<typeof CutWordsSchema>;
export type TranscriptJob = z.infer<typeof TranscriptJobSchema>;
export type MediaClip = z.infer<typeof MediaClipSchema>;

export const emptyProjectDocument = (): ProjectDocument => ({
  schemaVersion: 1,
  annotations: [],
  transcripts: [],
});
