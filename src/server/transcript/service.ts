import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { hyperframesCacheDir } from "@hyperframes/core/cache-dir";
import { z } from "zod";
import type { TranscribeOptions, TranscribeResult } from "hyperframes/api";
import { WordSchema } from "../../shared/project";
import type {
  CutWords,
  Project,
  TranscriptImport,
  TranscriptJob,
} from "../../shared/project";
import { HttpError } from "../../shared/errors";
import { createJobMachine } from "../../shared/jobs";
import {
  parseSourceDocument,
  patchElementInHtml,
} from "@hyperframes/studio-server";
import { projectPath, readSource } from "../projects/store";
import type { ProjectStore } from "../projects/store";
import { localMediaPath } from "../projects/media";
import {
  applyTranscriptCuts,
  originalClip,
  mediaElement,
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
    const info = await stat(join(modelsDir, name)).catch(() => null);
    const model = name.replace(/^ggml-/, "").replace(/\.bin$/, "");
    if (info?.isFile() && sizes[model] === info.size) complete.push(name);
  }
  return {
    available: !!binary && complete.length > 0,
    binary: binary ?? null,
    modelsDir,
    models: complete,
    model: complete[0]?.replace(/^ggml-/, "").replace(/\.bin$/, "") ?? null,
  };
}

export function createTranscriptService(
  store: ProjectStore,
  dependencies: {
    availability?: typeof transcriptionAvailability;
    transcribe?: (options: TranscribeOptions) => Promise<TranscribeResult>;
  } = {},
) {
  const jobs = new Map<string, TranscriptionJob>();
  const controllers = new Map<string, AbortController>();
  const running = new Set<Promise<void>>();
  const admitting = new Set<string>();
  let disposed = false;
  const availability = dependencies.availability ?? transcriptionAvailability;
  const readClip = async (
    project: Project,
    input: Pick<TranscriptImport, "sourceFile" | "mediaPath" | "elementId">,
  ) => {
    const [root, sourcePath] = await Promise.all([
      realpath(project.path),
      projectPath(project, input.sourceFile),
    ]);
    const sourceFile = relative(root, sourcePath).split(sep).join("/");
    const [source, mediaPath] = await Promise.all([
      readSource(project, sourceFile),
      projectPath(project, input.mediaPath),
    ]);
    const original = originalClip(source.content, input.elementId);
    const media = parseSourceDocument(original.html).document.querySelector(
      "video, audio",
    );
    const src =
      media?.getAttribute("src") ??
      media?.querySelector("source")?.getAttribute("src");
    const localPath = src && localMediaPath(sourceFile, src);
    if (!localPath)
      throw new HttpError(
        422,
        "Script editing supports valid local project media.",
      );
    const authoredPath = await projectPath(project, localPath);
    if (authoredPath !== mediaPath)
      throw new HttpError(
        400,
        "The transcript media must match the selected source element.",
      );
    return {
      original,
      source,
      sourceFile,
      sourcePath,
      mediaPath,
      mediaFile: relative(root, mediaPath).split(sep).join("/"),
      elementId: media?.id || input.elementId,
      transcriptId: media?.getAttribute("data-cutroom-transcript"),
    };
  };
  const importTranscript = async (
    project: Project,
    input: TranscriptImport,
    signal?: AbortSignal,
  ) =>
    store.mutate(project, "Import transcript", async () => {
      signal?.throwIfAborted();
      const clip = await readClip(project, input);
      const document = await store.document(project);
      if (
        document.transcripts.some(
          (transcript) => transcript.id === clip.transcriptId,
        )
      )
        throw new HttpError(
          409,
          "This clip already has a transcript. Keep its existing script to preserve cuts.",
        );
      let parsedSource: Document | undefined;
      for (const transcript of document.transcripts) {
        if (
          transcript.elementId !== clip.elementId &&
          !/^media:\d+$/.test(transcript.elementId)
        )
          continue;
        const sameSource =
          transcript.sourceFile === clip.sourceFile ||
          (await projectPath(project, transcript.sourceFile).then(
            (path) => path === clip.sourcePath,
            (error: unknown) => {
              if (error instanceof HttpError && error.status === 404)
                return false;
              throw error;
            },
          ));
        if (!sameSource) continue;
        parsedSource ??= parseSourceDocument(clip.source.content).document;
        const existingId =
          mediaElement(parsedSource, transcript.elementId)?.id ||
          transcript.elementId;
        if (existingId === clip.elementId)
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
      let elementId = clip.elementId;
      let original = clip.original;
      let after = clip.source.content;
      if (
        !parseSourceDocument(original.html).document.querySelector(
          "video, audio",
        )?.id
      ) {
        const index = /^media:(\d+)$/.exec(input.elementId)?.[1];
        if (index === undefined)
          throw new HttpError(
            422,
            "Choose a media element from the current composition.",
          );
        const patched = patchElementInHtml(
          after,
          { selector: "video, audio", selectorIndex: Number(index) },
          [
            {
              type: "ensure-id",
              property: "id",
              value: `cutroom-media-${randomUUID()}`,
            },
          ],
        );
        if (!patched.matched || !patched.elementId)
          throw new HttpError(
            409,
            "The selected media clip changed before its transcript could be imported.",
          );
        elementId = patched.elementId;
        after = patched.html;
        original = originalClip(after, elementId);
      }
      const transcript = {
        ...input,
        sourceFile: clip.sourceFile,
        mediaPath: clip.mediaFile,
        elementId,
        id: randomUUID(),
        cutWordIds: [],
        createdAt: new Date().toISOString(),
        original,
      };
      document.transcripts.push(transcript);
      signal?.throwIfAborted();
      await store.writeDocument(
        project,
        document,
        after === clip.source.content
          ? []
          : [
              {
                sourceFile: clip.sourceFile,
                absPath: clip.sourcePath,
                before: clip.source.content,
                after,
                expectedVersion: clip.source.version,
              },
            ],
      );
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
        transcript.original.start = transcriptStart(
          parseSourceDocument(source.content).document,
          transcript,
        );
        if (
          nextIds.length === previousIds.size &&
          nextIds.every((id) => previousIds.has(id))
        )
          return transcriptView(
            transcript,
            parseSourceDocument(source.content).document,
          );
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
      admitting.has(project.id) ||
      [...jobs.values()].some(
        (job) => job.projectId === project.id && job.status === "running",
      )
    )
      throw new HttpError(409, "This project is already being transcribed.");
    admitting.add(project.id);
    try {
      const installed = await availability();
      if (!installed.available || !installed.model)
        throw new HttpError(
          503,
          "Local transcription needs whisper-cli and a complete local Whisper model. Set HYPERFRAMES_WHISPER_PATH and HYPERFRAMES_CACHE_DIR, or import a transcript.",
        );
      const nonEnglish =
        input.language !== "en" && input.language !== "english";
      const modelName = installed.models.find(
        (name) => !nonEnglish || !name.endsWith(".en.bin"),
      );
      if (!modelName)
        throw new HttpError(
          503,
          "This language needs an installed multilingual Whisper model.",
        );
      const model = modelName.replace(/^ggml-/, "").replace(/\.bin$/, "");
      const { mediaPath: inputPath } = await readClip(project, input);
      if (disposed)
        throw new HttpError(503, "The transcription service is shutting down.");
      const machine = createJobMachine();
      machine.transition({ status: "running", progress: 0 });
      const job: TranscriptJob = {
        id: randomUUID(),
        projectId: project.id,
        get status() {
          switch (machine.state.status) {
            case "done":
              return "complete";
            case "failed":
              return "failed";
            case "cancelled":
              return "cancelled";
            default:
              return "running";
          }
        },
        message: "Preparing audio",
        get progress() {
          return machine.state.progress;
        },
      };
      const controller = new AbortController();
      jobs.set(job.id, job);
      controllers.set(job.id, controller);
      const run = (async () => {
        let scratch: string | undefined;
        let failure: string | undefined;
        try {
          scratch = await mkdtemp(join(tmpdir(), "cutroom-transcribe-"));
          controller.signal.throwIfAborted();
          const transcribe =
            dependencies.transcribe ??
            (await import("hyperframes/api")).transcribe;
          controller.signal.throwIfAborted();
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
              if (event.type === "words" && machine.state.status === "running")
                machine.transition({
                  status: "running",
                  progress: Math.min(
                    0.95,
                    event.through / Math.max(event.through + 5, 1),
                  ),
                });
            },
          });
          controller.signal.throwIfAborted();
          if (result.kind !== "transcribed")
            throw new Error("The transcription engine returned no transcript.");
          const raw: unknown = JSON.parse(
            await readFile(result.transcriptPath, "utf8"),
          );
          const words = NormalizedWordsSchema.parse(raw);
          const transcript = await importTranscript(
            project,
            { ...input, words },
            controller.signal,
          );
          job.transcriptId = transcript.id;
          job.message = `Transcribed ${words.length} words`;
        } catch (error) {
          // A completed history write wins a late abort; only an interrupted operation cancels.
          if (controller.signal.aborted)
            machine.transition({
              status: "cancelling",
              progress: machine.state.progress,
            });
          failure = error instanceof Error ? error.message : String(error);
          job.error = failure;
          job.message = controller.signal.aborted
            ? "Transcription cancelled"
            : "Transcription failed";
        } finally {
          try {
            if (scratch) await rm(scratch, { recursive: true, force: true });
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
            job.error = failure;
            job.message = "Transcription cleanup failed";
          }
          controllers.delete(job.id);
          if (machine.state.status === "cancelling")
            machine.transition({
              status: "cancelled",
              progress: machine.state.progress,
            });
          else if (failure)
            machine.transition({
              status: "failed",
              progress: machine.state.progress,
              error: failure,
            });
          else machine.transition({ status: "done", progress: 1 });
        }
      })();
      running.add(run);
      void run.finally(() => running.delete(run));
      return job;
    } finally {
      admitting.delete(project.id);
    }
  };
  return {
    importTranscript,
    cutWords,
    start,
    availability,
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
    list: async (project: Project) => {
      const sources = new Map<string, Promise<Document>>();
      return Promise.all(
        (await store.document(project)).transcripts.map(async (transcript) => {
          let source = sources.get(transcript.sourceFile);
          if (!source) {
            source = readSource(project, transcript.sourceFile).then(
              ({ content }) => parseSourceDocument(content).document,
            );
            sources.set(transcript.sourceFile, source);
          }
          return transcriptView(transcript, await source);
        }),
      );
    },
  };
}

export type TranscriptService = ReturnType<typeof createTranscriptService>;
