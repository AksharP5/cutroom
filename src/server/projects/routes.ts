import { EDIT_HISTORY_HEADER } from "../../shared/timeline/schema";
import { projectMutationGuard } from "./authorization";
import { Hono } from "hono";
import type { Context } from "hono";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { fileContentVersion } from "@hyperframes/studio-server";
import { historyActor } from "./historyActor";
import type { createTimelineRoutes } from "../timeline/routes";
import { HistoryRequestSchema, historySummary, replayHistory } from "./history";
import {
  AnnotationInputSchema,
  AnnotationPatchSchema,
  CreateProjectSchema,
  CutWordsSchema,
  DuplicateTimelineSchema,
  ImportProjectSchema,
  RenameProjectSchema,
  SourceWriteSchema,
  TranscribeInputSchema,
  TranscriptImportSchema,
} from "../../shared/project";
import {
  AGENT_HEADER,
  AgentReviewActionSchema,
  HumanReviewActionSchema,
  ReviewAddSchema,
  ReviewAcceptAllSchema,
  NoteContentSchema,
  ReviewReorderSchema,
} from "../../shared/review";
import type { ReviewActor } from "../../shared/review";
import { AcceptRowSchema } from "../../shared/timeline/reviewChanges";
import { HttpError } from "../../shared/errors";
import { ExportDestinationSchema } from "../../shared/export";
import { MediaRemoveSchema, MediaRenameSchema } from "../../shared/media";
import type { JobState } from "../../shared/jobs";
import type { Project } from "../../shared/project";
import { nextExportName } from "../hyperframes/exportName";
import { createTranscriptService } from "../transcript/service";
import type { TranscriptService } from "../transcript/service";
import { listMedia } from "./media";
import { mediaUses, removeMedia, renameMedia } from "./mediaFiles";
import { ReviewFileError, addAnnotation } from "./review";
import type { ReviewService } from "./review";
import { readSource } from "./store";
import { duplicateTimeline } from "./timelines";
import {
  canonicalProjectPath,
  listTimelines,
  projectStatePath,
  projectWritePath,
} from "./path";
import type { ProjectStore } from "./store";

export function parseInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; "),
    );
  return parsed.data;
}

export function historyWho(
  reviews: ReviewService,
  c: Context,
  project: Project,
) {
  return historyActor(reviews, c, project).who;
}

/** `reviews` must be the server's one review service, so every route shares its per-project queue. */
export function createProjectRoutes(
  store: ProjectStore,
  reviews: ReviewService,
  transcripts: TranscriptService = createTranscriptService(store),
  /** A video's editing proxy, which asking for starts; null when it needs none. */
  proxyState: (
    project: Project,
    path: string,
  ) => Promise<Readonly<JobState> | null> = async () => null,
  timelineSnapshot?: ReturnType<
    typeof createTimelineRoutes
  >["timelineSnapshot"],
  /** Why a project cannot leave the list yet, such as a running export; undefined when it can. */
  removalBlocker: (project: Project) => string | undefined = () => undefined,
) {
  const api = new Hono();
  const agentWho = (c: Context, project: Project) =>
    historyWho(reviews, c, project);
  api.use("/projects/:id/*", projectMutationGuard(reviews));
  api.use("/projects", projectMutationGuard(reviews));
  api.get("/projects", async (c) => c.json({ projects: await store.list() }));
  api.post("/projects", async (c) =>
    c.json(
      await store.create(parseInput(CreateProjectSchema, await c.req.json())),
      201,
    ),
  );
  api.post("/projects/import", async (c) =>
    c.json(
      await store.importProject(
        parseInput(ImportProjectSchema, await c.req.json()),
      ),
    ),
  );
  api.get("/projects/:id", async (c) =>
    c.json(await store.get(c.req.param("id"))),
  );
  api.patch("/projects/:id", async (c) => {
    const { name } = parseInput(RenameProjectSchema, await c.req.json());
    return c.json(await store.rename(c.req.param("id"), name));
  });
  // Removing only forgets the registry entry, and only the owner does it.
  api.delete("/projects/:id", async (c) => {
    if (c.req.header(AGENT_HEADER) !== undefined)
      throw new HttpError(403, "Only the owner can remove a project.");
    return c.json(await store.remove(c.req.param("id"), removalBlocker));
  });
  api.get("/projects/:id/export-defaults", async (c) => {
    const query = parseInput(
      ExportDestinationSchema.partial({ directory: true }),
      c.req.query(),
    );
    const project = await store.get(c.req.param("id"));
    if (query.directory && !isAbsolute(query.directory))
      throw new HttpError(400, "Enter an absolute output folder.");
    const defaultDirectory = await projectStatePath(
      project,
      ".cutroom/renders",
      true,
    );
    const directory =
      !query.directory || query.directory === defaultDirectory
        ? defaultDirectory
        : await realpath(query.directory);
    c.header("Cache-Control", "no-store");
    return c.json({
      directory,
      filename: await nextExportName(directory, query.filename),
    });
  });
  api.get("/projects/:id/document", async (c) => {
    const document = await store.document(await store.get(c.req.param("id")));
    // Status lives in the review queue; never echo a stale pre-queue copy.
    return c.json({
      ...document,
      annotations: document.annotations.map(
        ({ status: _status, ...annotation }) => annotation,
      ),
    });
  });
  api.get("/projects/:id/notebook", async (c) => {
    const project = await store.get(c.req.param("id"));
    const document = await store.document(project);
    const review = await reviews
      .list(project)
      .then((items) => ({ items }))
      .catch((error: unknown) => {
        if (error instanceof ReviewFileError)
          return { items: [], reviewError: error.message };
        throw error;
      });
    return c.json({
      ...review,
      transcriptVersion: fileContentVersion(
        JSON.stringify(document.transcripts),
      ),
    });
  });
  api.get("/projects/:id/media", async (c) => {
    const project = await store.get(c.req.param("id"));
    const media = await listMedia(project);
    const videos = [
      ...new Set(
        media.flatMap((clip) =>
          clip.kind === "video" ? [clip.mediaPath] : [],
        ),
      ),
    ];
    const proxies = new Map(
      await Promise.all(
        videos.map(
          async (path) => [path, await proxyState(project, path)] as const,
        ),
      ),
    );
    return c.json({
      media: media.map((clip) => {
        const proxy = proxies.get(clip.mediaPath);
        return proxy ? { ...clip, proxy } : clip;
      }),
    });
  });
  api.post("/projects/:id/media/rename", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(MediaRenameSchema, await c.req.json());
    return c.json(
      await reviews.editAssets(
        project,
        c.req.header(AGENT_HEADER),
        () => renameMedia(store, project, input, agentWho(c, project)),
        {
          sources: true,
          historyId: (result) => result.historyId,
        },
      ),
    );
  });
  api.get("/projects/:id/timelines", async (c) =>
    c.json({
      timelines: await listTimelines(await store.get(c.req.param("id"))),
    }),
  );
  api.post("/projects/:id/timelines/duplicate", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(DuplicateTimelineSchema, await c.req.json());
    const result = await reviews.editAssets(
      project,
      c.req.header(AGENT_HEADER),
      () => duplicateTimeline(store, project, input, agentWho(c, project)),
    );
    if (result.historyId) c.header(EDIT_HISTORY_HEADER, result.historyId);
    return c.json(result, 201);
  });
  /** The editor asks this before it removes, so its question is not a refused request. */
  api.get("/projects/:id/media/uses", async (c) => {
    const project = await store.get(c.req.param("id"));
    const { path } = parseInput(MediaRemoveSchema.pick({ path: true }), {
      path: c.req.query("path"),
    });
    return c.json({ uses: await mediaUses(project, path) });
  });
  api.post("/projects/:id/media/remove", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(MediaRemoveSchema, await c.req.json());
    const result = await reviews.editAssets(
      project,
      c.req.header(AGENT_HEADER),
      async () => {
        const uses = await mediaUses(project, input.path);
        if (uses && !input.confirmUsed) return { uses, historyId: undefined };
        return {
          ...(await removeMedia(store, project, input, agentWho(c, project))),
          uses,
        };
      },
      {
        sources: true,
        historyId: (result) => result.historyId,
      },
    );
    if (!("trash" in result))
      return c.json(
        {
          error: `${input.path} has ${result.uses} ${result.uses === 1 ? "use" : "uses"} in the project. Removing it leaves existing clips and references offline until the file is back. Send confirmUsed: true to remove it anyway.`,
          uses: result.uses,
        },
        409,
      );
    return c.json(result);
  });
  api.get("/projects/:id/source", async (c) =>
    c.json(
      await readSource(
        await store.get(c.req.param("id")),
        c.req.query("path") ?? "index.html",
      ),
    ),
  );
  api.put("/projects/:id/source", async (c) => {
    const project = await store.get(c.req.param("id"));
    const body = parseInput(SourceWriteSchema, await c.req.json());
    const token = c.req.header(AGENT_HEADER);
    const result = await reviews.editComposition(
      project,
      body.path,
      token,
      () =>
        store.mutateWithEntry(
          project,
          `Edit ${body.path}`,
          async () => {
            const absolute = await projectWritePath(project, body.path, {
              allowMissing: body.expectedVersion === null,
            });
            if (body.expectedVersion === null) {
              await mkdir(dirname(absolute), { recursive: true });
              const destination = await projectWritePath(project, body.path, {
                allowMissing: true,
              });
              await writeFile(destination, body.content, { flag: "wx" }).catch(
                (error: unknown) => {
                  if (
                    error instanceof Error &&
                    "code" in error &&
                    error.code === "EEXIST"
                  )
                    throw new HttpError(
                      409,
                      "The file already exists. Read it before saving.",
                    );
                  throw error;
                },
              );
              store.captureHistoryCreation(destination, body.content);
              return readSource(project, body.path);
            }
            const source = await readSource(project, body.path);
            if (source.version !== body.expectedVersion)
              throw new HttpError(
                409,
                "The file changed outside this editor. Refresh before saving.",
              );
            store.writeFiles(project, [
              {
                sourceFile: body.path,
                absPath: absolute,
                before: source.content,
                after: body.content,
                expectedVersion: body.expectedVersion,
              },
            ]);
            return readSource(project, body.path);
          },
          agentWho(c, project),
        ),
      body.noteId,
      { create: body.expectedVersion === null },
    );
    return c.json(result);
  });
  api.post("/projects/:id/annotations", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(AnnotationInputSchema, await c.req.json());
    const { value, entry } = await addAnnotation(
      store,
      project,
      input,
      agentWho(c, project),
    );
    if (entry) c.header(EDIT_HISTORY_HEADER, entry.id);
    return c.json(value, 201);
  });
  api.patch("/projects/:id/annotations/:annotationId", async (c) => {
    const project = await store.get(c.req.param("id"));
    const patch = parseInput(AnnotationPatchSchema, await c.req.json());
    return c.json(
      await reviews.edit(
        project,
        c.req.param("annotationId"),
        patch,
        agentWho(c, project),
      ),
    );
  });
  api.delete("/projects/:id/annotations/:annotationId", async (c) => {
    const project = await store.get(c.req.param("id"));
    await reviews.remove(
      project,
      c.req.param("annotationId"),
      agentWho(c, project),
    );
    return c.json({ ok: true });
  });
  api.get("/projects/:id/review", async (c) => {
    const project = await store.get(c.req.param("id"));
    return c.json({
      items: await reviews.list(project),
    });
  });
  api.put("/projects/:id/review/:noteId/frame", async (c) => {
    const project = await store.get(c.req.param("id"));
    const { framePath } = parseInput(
      NoteContentSchema.pick({ framePath: true }).required(),
      await c.req.json(),
    );
    await reviews.attachFrame(project, c.req.param("noteId"), framePath);
    return c.json({ ok: true });
  });
  api.post("/projects/:id/review", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(ReviewAddSchema, await c.req.json());
    return c.json(
      await reviews.add(
        project,
        input,
        c.req.header(AGENT_HEADER),
        agentWho(c, project),
      ),
      201,
    );
  });
  api.post("/projects/:id/review/changes", async (c) => {
    const project = await store.get(c.req.param("id"));
    const { composition, entries } = parseInput(
      z.object({
        composition: z.string(),
        entries: z.array(z.string()),
      }),
      await c.req.json(),
    );
    return c.json({
      clipEdits: await reviews.changeDetails(
        project,
        canonicalProjectPath(composition),
        new Set(entries),
      ),
    });
  });
  api.post("/projects/:id/review/changes/accept-all", async (c) => {
    const project = await store.get(c.req.param("id"));
    const token = c.req.header(AGENT_HEADER);
    if (
      token !== undefined &&
      reviews.agent(project, token).turn.kind !== "external"
    )
      throw new HttpError(
        409,
        "Only the owner or an outside client can accept agent changes.",
      );
    const scope = parseInput(ReviewAcceptAllSchema, await c.req.json());
    const composition =
      scope.scope === "composition"
        ? canonicalProjectPath(scope.composition)
        : undefined;
    const accepted = await reviews.acceptChanges(
      project,
      undefined,
      composition,
    );
    return c.json({ accepted });
  });
  api.post("/projects/:id/review/changes/accept", async (c) => {
    if (c.req.header(AGENT_HEADER))
      throw new HttpError(409, "Only the owner can accept agent changes.");
    const { editId } = parseInput(
      z.object({ editId: z.string().optional() }),
      await c.req.text().then((text) => (text ? JSON.parse(text) : {})),
    );
    await reviews.acceptChanges(await store.get(c.req.param("id")), editId);
    return c.json({ ok: true });
  });
  api.post("/projects/:id/review/changes/accept-row", async (c) => {
    if (c.req.header(AGENT_HEADER))
      throw new HttpError(409, "Only the owner can accept agent changes.");
    const input = parseInput(AcceptRowSchema, await c.req.json());
    const project = await store.get(c.req.param("id"));
    await reviews.acceptChanges(project, undefined, undefined, {
      ...input,
      composition: canonicalProjectPath(input.composition),
    });
    return c.json({ ok: true });
  });
  api.patch("/projects/:id/review/order", async (c) => {
    const project = await store.get(c.req.param("id"));
    const { noteId, beforeId } = parseInput(
      ReviewReorderSchema,
      await c.req.json(),
    );
    const token = c.req.header(AGENT_HEADER);
    const actor: ReviewActor =
      token === undefined ? { kind: "human" } : reviews.agent(project, token);
    return c.json({
      items: await reviews.reorder(project, noteId, beforeId, actor),
    });
  });
  api.post("/projects/:id/review/:itemId/human", async (c) => {
    if (c.req.header(AGENT_HEADER) !== undefined)
      throw new HttpError(409, "Agents must use the agent review route.");
    const project = await store.get(c.req.param("id"));
    const action = parseInput(HumanReviewActionSchema, await c.req.json());
    return c.json(
      await reviews.act(project, c.req.param("itemId"), action, {
        kind: "human",
      }),
    );
  });
  api.post("/projects/:id/review/:itemId/agent", async (c) => {
    const project = await store.get(c.req.param("id"));
    const action = parseInput(AgentReviewActionSchema, await c.req.json());
    const actor = reviews.agent(project, c.req.header(AGENT_HEADER));
    return c.json(
      await reviews.act(project, c.req.param("itemId"), action, actor),
    );
  });
  api.get("/transcription", async (c) =>
    c.json(await transcripts.availability()),
  );
  api.get("/projects/:id/transcripts", async (c) =>
    c.json({
      transcripts: await transcripts.list(await store.get(c.req.param("id"))),
    }),
  );
  api.post("/projects/:id/transcripts/import", async (c) => {
    const project = await store.get(c.req.param("id"));
    return c.json(
      await transcripts.importTranscript(
        project,
        parseInput(TranscriptImportSchema, await c.req.json()),
        { who: agentWho(c, project) },
      ),
      201,
    );
  });
  api.post("/projects/:id/transcribe", async (c) => {
    const project = await store.get(c.req.param("id"));
    return c.json(
      await transcripts.start(
        project,
        parseInput(TranscribeInputSchema, await c.req.json()),
        agentWho(c, project),
      ),
      202,
    );
  });
  api.get("/transcription-jobs/:jobId", (c) =>
    c.json(transcripts.getJob(c.req.param("jobId"))),
  );
  api.delete("/transcription-jobs/:jobId", (c) => {
    const job = transcripts.getJob(c.req.param("jobId"));
    reviews.authorize(c.req.header(AGENT_HEADER), job.projectId);
    return c.json(transcripts.cancel(job.id));
  });
  api.post("/projects/:id/transcripts/:transcriptId/cuts", async (c) => {
    const project = await store.get(c.req.param("id"));
    const transcriptId = c.req.param("transcriptId");
    const input = parseInput(CutWordsSchema, await c.req.json());
    const transcript = (await store.document(project)).transcripts.find(
      (item) => item.id === transcriptId,
    );
    if (!transcript) throw new HttpError(404, "Transcript not found.");
    return c.json(
      await reviews.editComposition(
        project,
        transcript.sourceFile,
        c.req.header(AGENT_HEADER),
        () =>
          transcripts.cutWords(
            project,
            transcriptId,
            input,
            agentWho(c, project),
          ),
        input.noteId,
      ),
    );
  });
  api.get("/projects/:id/history", async (c) => {
    const project = await store.get(c.req.param("id"));
    const { who } = historyActor(reviews, c, project);
    const history = await store.history(project);
    return c.json(await historySummary(project, history.list(), who));
  });
  for (const direction of ["undo", "redo"] as const) {
    api.post(`/projects/:id/history/${direction}`, async (c) => {
      const project = await store.get(c.req.param("id"));
      const body = await c.req.text();
      const input = parseInput(
        HistoryRequestSchema,
        body ? JSON.parse(body) : {},
      );
      const actor = historyActor(reviews, c, project);
      const composition =
        input.composition && canonicalProjectPath(input.composition);
      const result = await replayHistory(
        reviews,
        project,
        actor,
        direction,
        input,
      );
      if (!result.ok) return c.json(result, 409);
      if (result.skipped) {
        const history = await store.history(project);
        return c.json({
          ...result,
          history: await historySummary(project, history.list(), actor.who),
        });
      }
      if (!composition || !timelineSnapshot || !result.entry)
        return c.json(result);
      const view = await timelineSnapshot(project, composition).catch(
        (error: unknown) => {
          // The inverse already landed. A missing or unreadable composition is shown by the normal refresh.
          if (error instanceof HttpError) return null;
          throw error;
        },
      );
      const history = await store.history(project);
      return c.json({
        ...result,
        view: view && !view.error ? view : null,
        history: await historySummary(project, history.list(), actor.who),
      });
    });
  }
  return api;
}
