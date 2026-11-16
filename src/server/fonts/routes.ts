import { Hono } from "hono";
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import {
  FONT_FILE_BYTES,
  FONT_FILE_EXTENSIONS,
  GoogleFontAddSchema,
} from "../../shared/fonts";
import { AGENT_HEADER } from "../../shared/review";
import { projectMutationGuard } from "../projects/authorization";
import type { ReviewService } from "../projects/review";
import { historyWho, parseInput } from "../projects/routes";
import { readSource } from "../projects/store";
import type { ProjectStore } from "../projects/store";
import { declaredFonts } from "../timeline/titles";
import { readFontFile } from "./fontFile";
import { createGoogleFonts } from "./google";
import type { GoogleFonts } from "./google";
import { addFontFaces, hasFontFile } from "./project";

/** Files one import may carry, so a dropped folder cannot fill the project unasked. */
const IMPORT_FILES = 16;

const ListQuerySchema = z.object({
  query: z.string().trim().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export function createFontRoutes(
  store: ProjectStore,
  reviews: ReviewService,
  google: GoogleFonts = createGoogleFonts(),
) {
  const api = new Hono();
  api.use("/projects/:id/*", projectMutationGuard(reviews));

  api.get("/fonts/google", async (c) =>
    c.json({ families: await google.families() }),
  );

  /** The project's families and the Google families matching `query`, for agents. */
  api.get("/projects/:id/fonts", async (c) => {
    const project = await store.get(c.req.param("id"));
    const { query, limit } = parseInput(ListQuerySchema, c.req.query());
    const needle = query.toLowerCase();
    return c.json({
      declared: declaredFonts((await readSource(project)).content),
      google: (await google.families())
        .filter((entry) => entry.family.toLowerCase().includes(needle))
        .slice(0, limit),
    });
  });

  api.post("/projects/:id/fonts/google", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(GoogleFontAddSchema, await c.req.json());
    const { content } = await readSource(project);
    // Weights already in the project are not downloaded again.
    const weights = input.weights.filter(
      (weight) =>
        !hasFontFile(content, {
          family: input.family,
          weight,
          style: "normal",
          format: "truetype",
          extension: "ttf",
        }),
    );
    if (!weights.length) return c.json({ families: [input.family], files: [] });
    const faces = await google.download(input.family, weights);
    return c.json(
      await addFontFaces(
        store,
        reviews,
        project,
        faces,
        c.req.header(AGENT_HEADER),
        historyWho(reviews, c, project),
      ),
    );
  });

  api.post("/projects/:id/fonts/import", async (c) => {
    const project = await store.get(c.req.param("id"));
    const files = (
      await c.req.formData().catch(() => {
        throw new HttpError(400, "Send font files as form data.");
      })
    )
      .getAll("file")
      .filter((file) => file instanceof File);
    if (!files.length) throw new HttpError(400, "Choose a font file.");
    if (files.length > IMPORT_FILES)
      throw new HttpError(
        400,
        `Import up to ${IMPORT_FILES} font files at a time.`,
      );
    const faces = await Promise.all(
      files.map(async (file) => {
        const dot = file.name.lastIndexOf(".");
        const extension = dot > 0 ? file.name.slice(dot).toLowerCase() : "";
        if (!FONT_FILE_EXTENSIONS.some((known) => known === extension))
          throw new HttpError(
            400,
            `${file.name} is not a .ttf, .otf, .woff or .woff2 font.`,
          );
        if (file.size > FONT_FILE_BYTES)
          throw new HttpError(413, `${file.name} is larger than 20 MB.`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        try {
          return { ...readFontFile(bytes, file.name.slice(0, dot)), bytes };
        } catch (error) {
          if (error instanceof HttpError)
            throw new HttpError(error.status, `${file.name}: ${error.message}`);
          throw error;
        }
      }),
    );
    return c.json(
      await addFontFaces(
        store,
        reviews,
        project,
        faces,
        c.req.header(AGENT_HEADER),
        historyWho(reviews, c, project),
      ),
    );
  });
  return api;
}
