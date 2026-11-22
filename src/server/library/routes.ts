import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import {
  COMPONENT_SECONDS,
  LibraryAddSchema,
  LibrarySearchSchema,
  librarySearch,
} from "../../shared/library";
import type { LibraryCatalog } from "../../shared/library";
import { HttpError } from "../../shared/errors";
import { AGENT_HEADER } from "../../shared/review";
import { toFrames } from "../../shared/timeline/apply";
import { projectMutationGuard } from "../projects/authorization";
import type { ReviewService } from "../projects/review";
import { historyWho, parseInput } from "../projects/routes";
import type { ProjectStore } from "../projects/store";
import type { createTimelineRoutes } from "../timeline/routes";
import { addLibraryItem } from "./add";
import type { Library } from "./registry";

export function createLibraryRoutes(
  store: ProjectStore,
  reviews: ReviewService,
  library: Library,
  timeline: Pick<
    ReturnType<typeof createTimelineRoutes>,
    "editInWindow" | "timelineSnapshot"
  >,
) {
  const api = new Hono();
  api.use("/projects/:id/*", projectMutationGuard(reviews));

  /** Names whose files are already in the cache, read from the cache folder in one listing. */
  const cachedNames = async () => {
    const root = library.itemDir("");
    const names = await readdir(root).catch(() => []);
    const cached = await Promise.all(
      names.map((name) =>
        stat(join(root, name, ".files.json")).then(
          () => name,
          () => null,
        ),
      ),
    );
    return new Set(cached.filter((name) => name !== null));
  };

  const catalog = async (): Promise<LibraryCatalog> => {
    const [{ items, savedAt, offline }, cached] = await Promise.all([
      library.catalog(),
      cachedNames(),
    ]);
    // A saved list never needs the network, so a failed download is what says it is offline.
    return {
      ref: library.ref,
      savedAt,
      offline: offline || !(await library.reachable()),
      items: items.map((item) => library.describe(item, cached.has(item.name))),
    };
  };

  api.get("/library", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await catalog());
  });

  api.get("/library/posters/:name", async (c) => {
    const poster = await library.poster(
      await library.item(c.req.param("name")),
    );
    if (!poster) return c.notFound();
    return new Response(Bun.file(poster.path), {
      headers: {
        "content-type": poster.type,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });

  /** The items this project took files from, for the panel's "In this project". */
  api.get("/projects/:id/library/used", async (c) => {
    const document = await store.document(await store.get(c.req.param("id")));
    return c.json({ names: document.library?.map(({ name }) => name) ?? [] });
  });

  /** The search agents use: up to `limit` matches, each saying whether the project has it. */
  api.get("/projects/:id/library", async (c) => {
    const project = await store.get(c.req.param("id"));
    const { query, category, limit, composition } = parseInput(
      LibrarySearchSchema,
      c.req.query(),
    );
    const [{ items, offline }, document, view] = await Promise.all([
      catalog(),
      store.document(project),
      timeline.timelineSnapshot(project, composition),
    ]);
    // Lengths in the timeline's frames, as library_add and timeline_edit take them.
    const fps = "timeline" in view ? view.timeline?.fps : undefined;
    if (!fps)
      throw new HttpError(
        422,
        ("error" in view && view.error) || "The timeline cannot be read.",
      );
    const inProject = new Set(document.library?.map(({ name }) => name));
    const matches = librarySearch(query);
    return c.json({
      offline,
      items: items
        .filter(
          (item) =>
            !item.disabled &&
            (!category || item.category === category) &&
            matches(item),
        )
        .slice(0, limit)
        .map(({ hasPoster: _, cached: __, hidden: ___, ...item }) => ({
          ...item,
          duration: toFrames(item.duration ?? COMPONENT_SECONDS, fps),
          inProject: inProject.has(item.name),
        })),
    });
  });

  api.post("/projects/:id/library", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(LibraryAddSchema, await c.req.json());
    return c.json(
      await addLibraryItem({
        store,
        reviews,
        library,
        timeline,
        project,
        input,
        token: c.req.header(AGENT_HEADER),
        who: historyWho(reviews, c, project),
      }),
    );
  });
  return api;
}
