import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { Hono } from "hono";
import { parseSourceDocument } from "@hyperframes/studio-server";
import type { FileMutationInput } from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import {
  CaptionsEditSchema,
  SubtitleFormatSchema,
  SubtitleImportSchema,
} from "../../shared/captions";
import type {
  CaptionStyle,
  CaptionsEdit,
  CaptionsView,
} from "../../shared/captions";
import { TranscriptImportSchema } from "../../shared/project";
import type { Project, Transcript } from "../../shared/project";
import { AGENT_HEADER } from "../../shared/review";
import { sourcePath } from "../../shared/media";
import { toSeconds } from "../../shared/timeline/apply";
import { projectMutationGuard } from "../projects/authorization";
import { projectWritePath } from "../projects/path";
import type { ReviewService } from "../projects/review";
import { historyWho, parseInput } from "../projects/routes";
import { isMissing, readSource } from "../projects/store";
import type { ProjectStore } from "../projects/store";
import { transcriptView } from "../transcript/cuts";
import type { TranscriptService } from "../transcript/service";
import type { createTimelineRoutes } from "../timeline/routes";
import { setElementAttributes } from "../timeline/composition";
import { renderCaptions } from "./captions";
import {
  CAPTIONS_TRACK_KIND,
  captionsView,
  captionsWrite,
  compositionFrame,
  followTranscript,
  layoutCaptions,
  placedCaptions,
} from "./project";
import { cueWords, formatSubtitles, parseSubtitles } from "./subtitles";

const LABELS: Record<CaptionsEdit["action"], string> = {
  generate: "Add captions",
  style: "Restyle captions",
  word: "Edit a caption word",
};

export function createCaptionRoutes(
  store: ProjectStore,
  reviews: ReviewService,
  transcripts: TranscriptService,
  editInWindow: ReturnType<typeof createTimelineRoutes>["editInWindow"],
) {
  const transcriptOf = async (project: Project, id: string) => {
    const transcript = (await store.document(project)).transcripts.find(
      (item) => item.id === id,
    );
    if (!transcript) throw new HttpError(404, "Transcript not found.");
    return transcript;
  };

  /** A transcript's captions as placed in its composition, or null when it has none. */
  const viewOf = async (project: Project, transcript: Transcript) => {
    const { content } = await readSource(project, transcript.sourceFile);
    const placed = (
      await placedCaptions(project, transcript.sourceFile, content)
    ).find((item) => item.captions.transcriptId === transcript.id);
    return placed
      ? captionsView(placed, transcript, transcript.sourceFile, content)
      : null;
  };

  /** A new file beside the composition, `compositions/captions.html` unless that is taken. */
  const createFile = async (
    project: Project,
    sourceFile: string,
    html: (id: string) => string,
  ) => {
    const folder = posix.dirname(sourceFile);
    for (let index = 1; index < 100; index++) {
      const id = index === 1 ? "captions" : `captions-${index}`;
      const file = posix.join(folder, "compositions", `${id}.html`);
      const absolute = await projectWritePath(project, file, {
        allowMissing: true,
      });
      await mkdir(dirname(absolute), { recursive: true });
      const written = await writeFile(absolute, html(id), { flag: "wx" }).then(
        () => true,
        (error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
            return false;
          throw error;
        },
      );
      if (written) return { id, file };
    }
    throw new HttpError(
      409,
      "Too many captions files. Remove unused ones from compositions/.",
    );
  };

  /** New captions: a file, and a clip on a new Captions track above every other. */
  const add = async (
    project: Project,
    transcript: Transcript,
    html: string,
    style: CaptionStyle,
    agent: boolean,
  ) => {
    const { sourceFile } = transcript;
    const composition = compositionFrame(html);
    const layout = layoutCaptions(
      transcriptView(transcript, parseSourceDocument(html).document),
      style,
      new Map(),
      composition,
    );
    const duration = layout.durationFrames;
    const { file } = await createFile(project, sourceFile, (id) =>
      renderCaptions(
        layout.captions,
        { id, width: composition.width, height: composition.height },
        toSeconds(duration, composition.fps),
      ),
    );
    const src = sourcePath(sourceFile, file);
    const result = await editInWindow(
      project,
      sourceFile,
      (timeline) => {
        const track =
          Math.max(
            -1,
            ...timeline.tracks.map((item) => item.index),
            ...timeline.clips.map((clip) => clip.track),
          ) + 1;
        return [
          { type: "setTrack", index: track, kind: "video", name: "Captions" },
          {
            type: "insert",
            track,
            at: layout.startFrame,
            clip: { kind: "composition", src, duration, label: "Captions" },
          },
        ];
      },
      agent,
    );
    const clip = result.timeline.clips.find(
      (item) => item.kind === "composition" && item.src === src,
    );
    const source = await readSource(project, sourceFile);
    // Studio and lint read the captions track from its host; the timeline keeps the attribute.
    const marked =
      clip &&
      setElementAttributes(source.content, clip.id, [
        ["data-track-kind", CAPTIONS_TRACK_KIND],
      ]);
    if (!marked) throw new HttpError(500, "The captions clip was not placed.");
    store.writeFiles(project, [
      {
        sourceFile,
        absPath: await projectWritePath(project, sourceFile),
        before: source.content,
        after: marked,
        expectedVersion: source.version,
      },
    ]);
  };

  const edit = async (
    project: Project,
    input: CaptionsEdit,
    agent: boolean,
  ) => {
    const transcript = await transcriptOf(project, input.transcriptId);
    const { sourceFile } = transcript;
    const source = await readSource(project, sourceFile);
    const placed = (
      await placedCaptions(project, sourceFile, source.content)
    ).find((item) => item.captions.transcriptId === transcript.id);
    if (input.action === "generate" && !placed) {
      await add(
        project,
        transcript,
        source.content,
        input.style ?? "karaoke",
        agent,
      );
      return;
    }
    if (!placed)
      throw new HttpError(
        404,
        "This transcript has no captions. Add captions first.",
      );
    let files: FileMutationInput[];
    if (input.action === "generate") {
      const followed = await followTranscript(
        project,
        transcript,
        sourceFile,
        source.content,
        input.style,
      );
      files = [
        ...followed!.files,
        {
          sourceFile,
          absPath: await projectWritePath(project, sourceFile),
          before: source.content,
          after: followed!.html,
          expectedVersion: source.version,
        },
      ];
    } else if (input.action === "style") {
      files = [
        await captionsWrite(project, placed, {
          ...placed.captions,
          style: input.style,
        }),
      ];
    } else {
      const groups = placed.captions.groups.map((group) => ({
        ...group,
        words: group.words.map((word) =>
          word.id === input.wordId ? { ...word, text: input.text } : word,
        ),
      }));
      if (
        !groups.some((group) =>
          group.words.some((word) => word.id === input.wordId),
        )
      )
        throw new HttpError(
          404,
          "That word is not in the captions. It may be cut.",
        );
      files = [
        await captionsWrite(project, placed, { ...placed.captions, groups }),
      ];
    }
    store.writeFiles(
      project,
      files.filter((file) => file.before !== file.after),
    );
  };

  const api = new Hono();
  api.use("/projects/:id/*", projectMutationGuard(reviews));
  api.get("/projects/:id/captions", async (c) => {
    const project = await store.get(c.req.param("id"));
    const views: CaptionsView[] = [];
    for (const transcript of (await store.document(project)).transcripts) {
      const view = await viewOf(project, transcript).catch((error: unknown) => {
        // A composition that is gone or unreadable has no captions to show.
        if (
          isMissing(error) ||
          (error instanceof HttpError && error.status < 500)
        )
          return null;
        throw error;
      });
      if (view) views.push(view);
    }
    return c.json({ captions: views });
  });
  api.post("/projects/:id/captions", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(CaptionsEditSchema, await c.req.json());
    const transcript = await transcriptOf(project, input.transcriptId);
    const token = c.req.header(AGENT_HEADER);
    const label =
      input.action === "generate" && (await viewOf(project, transcript))
        ? "Regenerate captions"
        : LABELS[input.action];
    await reviews.editComposition(
      project,
      transcript.sourceFile,
      token,
      () =>
        store.mutate(
          project,
          label,
          () => edit(project, input, token !== undefined),
          historyWho(reviews, c, project),
        ),
      input.noteId,
    );
    return c.json(await viewOf(project, transcript));
  });
  api.get("/projects/:id/captions/:transcriptId/export", async (c) => {
    const project = await store.get(c.req.param("id"));
    const format = parseInput(SubtitleFormatSchema, c.req.query("format"));
    const transcript = await transcriptOf(project, c.req.param("transcriptId"));
    const view = await viewOf(project, transcript);
    if (!view)
      throw new HttpError(
        404,
        "This transcript has no captions. Add captions first.",
      );
    const name =
      posix.basename(transcript.mediaPath).replace(/\.[^.]+$/, "") ||
      "captions";
    return c.json({
      format,
      filename: `${name}.${format}`,
      text: formatSubtitles(view.cues, format),
    });
  });
  api.post("/projects/:id/transcripts/subtitles", async (c) => {
    const project = await store.get(c.req.param("id"));
    const { format, text, ...clip } = parseInput(
      SubtitleImportSchema,
      await c.req.json(),
    );
    const words = cueWords(parseSubtitles(text, format));
    return c.json(
      await transcripts.importTranscript(
        project,
        parseInput(TranscriptImportSchema, { ...clip, words }),
      ),
      201,
    );
  });
  return api;
}
