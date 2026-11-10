import { Hono } from "hono";
import { z } from "zod";
import {
  applyFileMutations,
  fileContentVersion,
} from "@hyperframes/studio-server";
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
  AgentReviewActionSchema,
  HumanReviewActionSchema,
  ReviewAddSchema,
} from "../../shared/review";
import { HttpError } from "../../shared/errors";
import { createTranscriptService } from "../transcript/service";
import type { TranscriptService } from "../transcript/service";
import { listMedia } from "./media";
import { ReviewFileError, addAnnotation, createReviewService } from "./review";
import type { ReviewService } from "./review";
import { projectPath, readSource } from "./store";
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

export function createProjectRoutes(
  store: ProjectStore,
  transcripts: TranscriptService = createTranscriptService(store),
  reviews: ReviewService = createReviewService(store),
) {
  const api = new Hono();
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
      .list(project, document)
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
    const result = await store.mutate(
      project,
      `Edit ${body.path}`,
      async () => {
        const source = await readSource(project, body.path);
        if (source.version !== body.expectedVersion)
          throw new HttpError(
            409,
            "The file changed outside this editor. Refresh before saving.",
          );
        applyFileMutations(project.path, [
          {
            sourceFile: body.path,
            absPath: await projectPath(project, body.path),
            before: source.content,
            after: body.content,
            expectedVersion: body.expectedVersion,
          },
        ]);
        return readSource(project, body.path);
      },
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
    const annotation = await store.mutate(
      project,
      "Update comment",
      async () => {
        const document = await store.document(project);
        const index = document.annotations.findIndex(
          (item) => item.id === c.req.param("annotationId"),
        );
        if (index < 0) throw new HttpError(404, "Annotation not found.");
        const changed = {
          ...document.annotations[index]!,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        document.annotations[index] = changed;
        await store.writeDocument(project, document);
        return changed;
      },
    );
    return c.json(annotation);
  });
  api.delete("/projects/:id/annotations/:annotationId", async (c) => {
    const project = await store.get(c.req.param("id"));
    await store.mutate(project, "Remove comment", async () => {
      const document = await store.document(project);
      const index = document.annotations.findIndex(
        (item) => item.id === c.req.param("annotationId"),
      );
      if (index < 0) throw new HttpError(404, "Annotation not found.");
      const item = (await reviews.list(project, document)).find(
        (candidate) => candidate.id === c.req.param("annotationId"),
      );
      if (item && item.review.status !== "open")
        throw new HttpError(
          409,
          "Only unsent notes can be deleted. Withdraw a submitted note so its reason is recorded.",
        );
      document.annotations.splice(index, 1);
      await store.writeDocument(project, document);
    });
    return c.json({ ok: true });
  });
  api.get("/projects/:id/review", async (c) => {
    const project = await store.get(c.req.param("id"));
    return c.json({
      items: await reviews.list(project, await store.document(project)),
    });
  });
  api.post("/projects/:id/review", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(ReviewAddSchema, await c.req.json());
    return c.json(await reviews.add(project, input), 201);
  });
  for (const [actor, schema] of [
    ["human", HumanReviewActionSchema],
    ["agent", AgentReviewActionSchema],
  ] as const) {
    api.post(`/projects/:id/review/:itemId/${actor}`, async (c) => {
      const project = await store.get(c.req.param("id"));
      const action = parseInput(schema, await c.req.json());
      return c.json(
        await reviews.act(project, c.req.param("itemId"), action, actor),
      );
    });
  }
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
  api.delete("/transcription-jobs/:jobId", (c) =>
    c.json(transcripts.cancel(c.req.param("jobId"))),
  );
  api.post("/projects/:id/transcripts/:transcriptId/cuts", async (c) =>
    c.json(
      await transcripts.cutWords(
        await store.get(c.req.param("id")),
        c.req.param("transcriptId"),
        parseInput(CutWordsSchema, await c.req.json()),
      ),
    ),
  );
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
      const history = await store.history(await store.get(c.req.param("id")));
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
