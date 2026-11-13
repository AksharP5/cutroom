import { projectMutationGuard } from "./authorization";
import { Hono } from "hono";
import type { Context } from "hono";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import {
  applyFileMutations,
  fileContentVersion,
} from "@hyperframes/studio-server";
import type { HistoryWho } from "@hyperframes/studio-server";
import {
  AnnotationInputSchema,
  AnnotationPatchSchema,
  CreateProjectSchema,
  CutWordsSchema,
  ImportProjectSchema,
  SourceWriteSchema,
  TranscribeInputSchema,
  TranscriptImportSchema,
} from "../../shared/project";
import {
  AGENT_HEADER,
  AGENT_NAME_HEADER,
  AgentNameSchema,
  AgentReviewActionSchema,
  HumanReviewActionSchema,
  ReviewAddSchema,
  NoteContentSchema,
  ReviewReorderSchema,
} from "../../shared/review";
import type { ReviewActor } from "../../shared/review";
import { HttpError } from "../../shared/errors";
import { ExportDestinationSchema } from "../../shared/export";
import { MediaRemoveSchema, MediaRenameSchema } from "../../shared/media";
import type { Project } from "../../shared/project";
import { nextExportName } from "../hyperframes/exportName";
import { createTranscriptService } from "../transcript/service";
import type { TranscriptService } from "../transcript/service";
import { listMedia } from "./media";
import { mediaUses, removeMedia, renameMedia } from "./mediaFiles";
import { ReviewFileError, addAnnotation } from "./review";
import type { ReviewService } from "./review";
import { readSource } from "./store";
import { projectStatePath, projectWritePath } from "./path";
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

/** `reviews` must be the server's one review service, so every route shares its per-project queue. */
export function createProjectRoutes(
  store: ProjectStore,
  reviews: ReviewService,
  transcripts: TranscriptService = createTranscriptService(store),
) {
  const api = new Hono();
  /** Whose history entry an edit is: the calling agent's, or the owner's when undefined. */
  const agentWho = (c: Context, project: Project): HistoryWho | undefined => {
    const token = c.req.header(AGENT_HEADER);
    if (token === undefined) return undefined;
    return {
      kind: "agent",
      name:
        reviews.agent(project, token).turn.name ??
        parseInput(
          AgentNameSchema,
          decodeURIComponent(c.req.header(AGENT_NAME_HEADER) ?? "Agent"),
        ),
    };
  };
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
  api.get("/projects/:id/media", async (c) =>
    c.json({ media: await listMedia(await store.get(c.req.param("id"))) }),
  );
  api.post("/projects/:id/media/rename", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(MediaRenameSchema, await c.req.json());
    return c.json(
      await reviews.editAssets(
        project,
        c.req.header(AGENT_HEADER),
        () => renameMedia(store, project, input, agentWho(c, project)),
        { sources: true },
      ),
    );
  });
  api.post("/projects/:id/media/remove", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(MediaRemoveSchema, await c.req.json());
    const uses = await mediaUses(project, input.path);
    if (uses && !input.confirmUsed)
      return c.json(
        {
          error: `${uses} timeline ${uses === 1 ? "clip uses" : "clips use"} ${input.path}. Removing it leaves ${uses === 1 ? "that clip" : "those clips"} empty until the file is back. Send confirmUsed: true to remove it anyway.`,
          uses,
        },
        409,
      );
    return c.json({
      ...(await reviews.editAssets(
        project,
        c.req.header(AGENT_HEADER),
        () => removeMedia(store, project, input, agentWho(c, project)),
        { sources: true },
      )),
      uses,
    });
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
        store.mutate(
          project,
          `Edit ${body.path}`,
          async () => {
            const absolute = await projectWritePath(project, body.path, {
              allowMissing: body.expectedVersion === null,
            });
            if (body.expectedVersion === null) {
              await mkdir(dirname(absolute), { recursive: true });
              await writeFile(
                await projectWritePath(project, body.path, {
                  allowMissing: true,
                }),
                body.content,
                { flag: "wx" },
              ).catch((error: unknown) => {
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
              });
              return readSource(project, body.path);
            }
            const source = await readSource(project, body.path);
            if (source.version !== body.expectedVersion)
              throw new HttpError(
                409,
                "The file changed outside this editor. Refresh before saving.",
              );
            applyFileMutations(project.path, [
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
    return c.json(await addAnnotation(store, project, input), 201);
  });
  api.patch("/projects/:id/annotations/:annotationId", async (c) => {
    const project = await store.get(c.req.param("id"));
    const patch = parseInput(AnnotationPatchSchema, await c.req.json());
    return c.json(
      await reviews.edit(project, c.req.param("annotationId"), patch),
    );
  });
  api.delete("/projects/:id/annotations/:annotationId", async (c) => {
    const project = await store.get(c.req.param("id"));
    await reviews.remove(project, c.req.param("annotationId"));
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
      await reviews.add(project, input, c.req.header(AGENT_HEADER)),
      201,
    );
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
  api.post("/projects/:id/transcripts/import", async (c) =>
    c.json(
      await transcripts.importTranscript(
        await store.get(c.req.param("id")),
        parseInput(TranscriptImportSchema, await c.req.json()),
      ),
      201,
    ),
  );
  api.post("/projects/:id/transcribe", async (c) =>
    c.json(
      await transcripts.start(
        await store.get(c.req.param("id")),
        parseInput(TranscribeInputSchema, await c.req.json()),
      ),
      202,
    ),
  );
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
        () => transcripts.cutWords(project, transcriptId, input),
        input.noteId,
      ),
    );
  });
  api.get("/projects/:id/history", async (c) => {
    const history = await store.history(await store.get(c.req.param("id")));
    return c.json({
      entries: history.list(),
      canUndo: !!history.next("back", { kind: "person", name: "You" }),
      canRedo: !!history.next("forward", { kind: "person", name: "You" }),
    });
  });
  for (const [route, direction] of [
    ["undo", "back"],
    ["redo", "forward"],
  ] as const) {
    api.post(`/projects/:id/history/${route}`, async (c) => {
      const project = await store.get(c.req.param("id"));
      const agent = c.req.header(AGENT_HEADER);
      const actor: ReviewActor =
        agent === undefined ? { kind: "human" } : reviews.agent(project, agent);
      const history = reviews.history(
        project,
        await store.history(project),
        actor,
      );
      const result = await history.step(direction, {
        kind: "person",
        name: "You",
      });
      if (!result.ok)
        throw new HttpError(
          409,
          `History conflicts with newer edits in ${result.conflict.files.join(", ")}.`,
        );
      return c.json(result);
    });
  }
  return api;
}
