import { Hono } from "hono";
import { HttpError } from "../../shared/errors";
import { LutImportSchema, LutPathSchema } from "../../shared/timeline/grade";
import { projectMutationGuard } from "../projects/authorization";
import type { ReviewService } from "../projects/review";
import { parseInput } from "../projects/routes";
import type { ProjectStore } from "../projects/store";
import {
  LUT_FILE_BYTES,
  importLutFile,
  listLuts,
  readCube,
  readProjectLutBytes,
  saveLut,
} from "./luts";

export function createGradeRoutes(store: ProjectStore, reviews: ReviewService) {
  const api = new Hono();
  api.use("/projects/:id/*", projectMutationGuard(reviews));

  api.get("/projects/:id/luts", async (c) => {
    const project = await store.get(c.req.param("id"));
    return c.json({ luts: await listLuts(project) });
  });

  // The entry composition's look LUT, parsed and baked in the playback worker.
  api.get("/projects/:id/luts/source", async (c) => {
    const src = LutPathSchema.parse(c.req.query("path"));
    const project = await store.get(c.req.param("id"));
    const bytes = await readProjectLutBytes(project, "index.html", src);
    return c.body(bytes, 200, {
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
    });
  });

  /** The editor uploads a chosen file; an agent names one on this computer. */
  api.post("/projects/:id/luts", async (c) => {
    const project = await store.get(c.req.param("id"));
    if (c.req.header("content-type")?.startsWith("multipart/form-data")) {
      const file = (
        await c.req.formData().catch(() => {
          throw new HttpError(400, "Send the .cube file as form data.");
        })
      ).get("file");
      if (!(file instanceof File) || !/\.cube$/i.test(file.name))
        throw new HttpError(400, "Choose a .cube file.");
      if (file.size > LUT_FILE_BYTES)
        throw new HttpError(413, "A .cube LUT must be smaller than 16 MB.");
      return c.json(
        await saveLut(
          project,
          file.name,
          readCube(new Uint8Array(await file.arrayBuffer())),
        ),
      );
    }
    const { path } = parseInput(LutImportSchema, await c.req.json());
    return c.json(await importLutFile(project, path));
  });
  return api;
}
