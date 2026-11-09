import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hyperframesCacheDir } from "@hyperframes/core/cache-dir";
import { z } from "zod";
import { WordSchema } from "../../shared/project";
import type {
  CutWords,
  Project,
  TranscriptImport,
  TranscriptJob,
} from "../../shared/project";
import { HttpError } from "../../shared/errors";
import { parseSourceDocument } from "@hyperframes/studio-server";
import { projectPath, readSource } from "../projects/store";
import type { ProjectStore } from "../projects/store";
import {
  applyTranscriptCuts,
  originalClip,
  transcriptStart,
  transcriptView,
} from "./cuts";

const NormalizedWordsSchema = z.array(WordSchema);
export type TranscriptionJob = TranscriptJob;

export async function transcriptionAvailability() {
  const home = homedir();
  const binaryCandidates = [
    process.env.HYPERFRAMES_WHISPER_PATH,
    Bun.which("whisper-cli"),
    join(home, ".cache/hyperframes/whisper/whisper.cpp/build/bin/whisper-cli"),
  ].filter((item): item is string => !!item);
  const binary = binaryCandidates.find((path) => existsSync(path));
  const modelsDir = hyperframesCacheDir("whisper", "models");
  const installed: string[] = await readdir(modelsDir).catch(() => []);
  const preferred = [
    "ggml-small.en.bin",
    "ggml-base.en.bin",
    "ggml-small.bin",
    "ggml-base.bin",
    "ggml-tiny.en.bin",
    "ggml-tiny.bin",
    ...installed,
  ];
  const models = [...new Set(preferred)].filter(
    (name) => /^ggml-[a-z0-9.-]+\.bin$/.test(name) && installed.includes(name),
  );
  // These sizes match the pinned HyperFrames 0.9.26 models; partial files must never trigger its downloader.
  const sizes: Readonly<Record<string, number>> = {
    tiny: 77_691_713,
    "tiny.en": 77_704_715,
    base: 147_951_465,
    "base.en": 147_964_211,
    small: 487_601_967,
    "small.en": 487_614_201,
    medium: 1_533_763_059,
    "medium.en": 1_533_774_781,
  };
  const complete: string[] = [];
  for (const name of models) {
    const info = await stat(join(modelsDir, name));
    const model = name.replace(/^ggml-/, "").replace(/\.bin$/, "");
    if (info.isFile() && sizes[model] === info.size) complete.push(name);
  }
  return {
    available: !!binary && complete.length > 0,
    binary: binary ?? null,
    modelsDir,
    models: complete,
    model: complete[0]?.replace(/^ggml-/, "").replace(/\.bin$/, "") ?? null,
  };
}

export function createTranscriptService(store: ProjectStore) {
  const jobs = new Map<string, TranscriptionJob>();
  const controllers = new Map<string, AbortController>();
  const running = new Set<Promise<void>>();
  let disposed = false;
  const importTranscript = async (project: Project, input: TranscriptImport) =>
    store.mutate(project, "Import transcript", async () => {
      const source = await readSource(project, input.sourceFile);
      const mediaPath = await projectPath(project, input.mediaPath);
      const original = originalClip(source.content, input.elementId);
      const media = parseSourceDocument(original.html).document.querySelector(
        "video, audio",
      );
      const src =
        media?.getAttribute("src") ??
        media?.querySelector("source")?.getAttribute("src");
      if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//"))
        throw new HttpError(
          422,
          "Script editing supports local project media.",
        );
      const authoredPath = await projectPath(
        project,
        join(
          dirname(input.sourceFile),
          decodeURIComponent(src.split(/[?#]/, 1)[0]!),
        ),
      );
      if (authoredPath !== mediaPath)
        throw new HttpError(
          400,
          "The transcript media must match the selected source element.",
        );
      const document = await store.document(project);
      if (
        document.transcripts.some(
          (transcript) =>
            transcript.sourceFile === input.sourceFile &&
            transcript.elementId === input.elementId,
        )
      ) {
        throw new HttpError(
          409,
          "This clip already has a transcript. Keep its existing script to preserve cuts.",
        );
      }
      if (
        new Set(input.words.map((word) => word.id)).size !== input.words.length
      )
        throw new HttpError(400, "Transcript word IDs must be unique.");
      if (
        input.words.some(
          (word, index) =>
            index > 0 && word.start < input.words[index - 1]!.start,
        )
      )
        throw new HttpError(
          400,
          "Transcript words must be ordered by their source timestamps.",
        );
      const transcript = {
        ...input,
        id: randomUUID(),
        cutWordIds: [],
        createdAt: new Date().toISOString(),
        original,
      };
      document.transcripts.push(transcript);
      await store.writeDocument(project, document);
      return transcriptView(transcript);
    });
  const cutWords = async (
    project: Project,
    transcriptId: string,
    input: CutWords,
  ) =>
    store.mutate(
      project,
      input.action === "cut" ? "Cut script words" : "Restore script words",
      async () => {
        const document = await store.document(project);
        const transcript = document.transcripts.find(
          (item) => item.id === transcriptId,
        );
        if (!transcript) throw new HttpError(404, "Transcript not found.");
        const validIds = new Set(transcript.words.map((word) => word.id));
        if (input.wordIds.some((id) => !validIds.has(id)))
          throw new HttpError(
            400,
            "A selected word is not in this transcript.",
          );
        const previousIds = new Set(transcript.cutWordIds);
        const selected = new Set(previousIds);
        for (const id of input.wordIds)
          input.action === "cut" ? selected.add(id) : selected.delete(id);
        const source = await readSource(project, transcript.sourceFile);
        if (input.expectedVersion && input.expectedVersion !== source.version)
          throw new HttpError(
            409,
            "The composition changed. Refresh the script before cutting.",
          );
        const nextIds = [...selected];
        if (
          nextIds.length === previousIds.size &&
          nextIds.every((id) => previousIds.has(id))
        )
          return transcriptView(transcript);
        transcript.original.start = transcriptStart(source.content, transcript);
        const after = applyTranscriptCuts(source.content, transcript, nextIds);
        transcript.cutWordIds = nextIds;
        await store.writeDocument(project, document, [
          {
            sourceFile: transcript.sourceFile,
            absPath: await projectPath(project, transcript.sourceFile),
            before: source.content,
            after,
            expectedVersion: source.version,
          },
        ]);
        return transcriptView(transcript);
      },
    );

  const start = async (
    project: Project,
    input: Omit<TranscriptImport, "words">,
  ) => {
    if (disposed)
      throw new HttpError(503, "The transcription service is shutting down.");
    if (
      [...jobs.values()].some(
        (job) => job.projectId === project.id && job.status === "running",
      )
    )
      throw new HttpError(409, "This project is already being transcribed.");
    const availability = await transcriptionAvailability();
    if (!availability.available || !availability.model)
      throw new HttpError(
        503,
        "Local transcription needs whisper-cli and a complete local Whisper model. Set HYPERFRAMES_WHISPER_PATH and HYPERFRAMES_CACHE_DIR, or import a transcript.",
      );
    const nonEnglish = input.language !== "en" && input.language !== "english";
    const modelName = availability.models.find(
      (name) => !nonEnglish || !name.endsWith(".en.bin"),
    );
    if (!modelName)
      throw new HttpError(
        503,
        "This language needs an installed multilingual Whisper model.",
      );
    const model = modelName.replace(/^ggml-/, "").replace(/\.bin$/, "");
    const inputPath = await projectPath(project, input.mediaPath);
    originalClip(
      (await readSource(project, input.sourceFile)).content,
      input.elementId,
    );
    const job: TranscriptJob = {
      id: randomUUID(),
      projectId: project.id,
      status: "running",
      message: "Preparing audio",
      progress: 0,
    };
    const controller = new AbortController();
    jobs.set(job.id, job);
    controllers.set(job.id, controller);
    const run = (async () => {
      let scratch: string | undefined;
      try {
        scratch = await mkdtemp(join(tmpdir(), "cutroom-transcribe-"));
        const { transcribe } = await import("hyperframes/api");
        const result = await transcribe({
          input: inputPath,
          dir: scratch,
          engine: "whisper",
          model,
          language: input.language,
          installRuntime: false,
          signal: controller.signal,
          onStatus: (message) => {
            job.message = message;
          },
          onProgress: (event) => {
            if (event.type === "progress" && event.phase === "download")
              controller.abort(
                new Error(
                  "The installed model changed while transcription was starting.",
                ),
              );
            if (event.type === "words")
              job.progress = Math.min(
                0.95,
                event.through / Math.max(event.through + 5, 1),
              );
          },
        });
        if (result.kind !== "transcribed")
          throw new Error("The transcription engine returned no transcript.");
        const raw: unknown = JSON.parse(
          await readFile(result.transcriptPath, "utf8"),
        );
        const words = NormalizedWordsSchema.parse(raw);
        const transcript = await importTranscript(project, { ...input, words });
        job.transcriptId = transcript.id;
        job.status = "complete";
        job.progress = 1;
        job.message = `Transcribed ${words.length} words`;
      } catch (error) {
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.message =
          job.status === "cancelled"
            ? "Transcription cancelled"
            : "Transcription failed";
      } finally {
        if (scratch) await rm(scratch, { recursive: true, force: true });
        controllers.delete(job.id);
      }
    })().catch((error: unknown) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.message = "Transcription cleanup failed";
      controllers.delete(job.id);
    });
    running.add(run);
    void run.finally(() => running.delete(run));
    return job;
  };
  return {
    importTranscript,
    cutWords,
    start,
    availability: transcriptionAvailability,
    getJob(id: string) {
      const job = jobs.get(id);
      if (!job) throw new HttpError(404, "Transcription job not found.");
      return job;
    },
    cancel(id: string) {
      const controller = controllers.get(id);
      if (!controller)
        throw new HttpError(404, "Running transcription not found.");
      controller.abort();
      return this.getJob(id);
    },
    async dispose() {
      disposed = true;
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled([...running]);
    },
    list: async (project: Project) =>
      Promise.all(
        (await store.document(project)).transcripts.map(async (transcript) => {
          const source = await readSource(project, transcript.sourceFile);
          return transcriptView({
            ...transcript,
            original: {
              ...transcript.original,
              start: transcriptStart(source.content, transcript),
            },
          });
        }),
      ),
  };
}

export type TranscriptService = ReturnType<typeof createTranscriptService>;
