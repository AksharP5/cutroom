import { posix } from "node:path";
import { fileContentVersion } from "@hyperframes/studio-server";
import { Hono } from "hono";
import { HttpError } from "../../shared/errors";
import {
  LayerTextQuerySchema,
  LayerTextUpdateSchema,
} from "../../shared/layerText";
import type { LayerTextSnapshot } from "../../shared/layerText";
import type { Project } from "../../shared/project";
import { AGENT_HEADER } from "../../shared/review";
import { TimelineError } from "../../shared/timeline/apply";
import { previewTimingPolicy } from "../hyperframes/previewTimingPolicy";
import { inspectLayerText } from "../timeline/composition";
import { projectMutationGuard } from "./authorization";
import { lockedCompositionTracks } from "./lockedCompositionTracks";
import { projectWritePath, resolveProjectPath } from "./path";
import type { ReviewService } from "./review";
import { historyWho, parseInput } from "./routes";
import { readSource } from "./store";
import type { ProjectStore } from "./store";

async function compositionFile(project: Project, path: string) {
  const requested = posix.normalize(path.replaceAll("\\", "/"));
  const resolved = await resolveProjectPath(project, requested);
  if (!/\.html?$/i.test(requested) || !/\.html?$/i.test(resolved.path))
    throw new HttpError(400, "Choose an HTML composition inside the project.");
  const absolute = await projectWritePath(project, requested);
  if (absolute !== resolved.absolute)
    throw new HttpError(
      409,
      "The composition path changed. Inspect layers again.",
    );
  return resolved;
}

export function createLayerTextRoutes(
  store: ProjectStore,
  reviews: ReviewService,
) {
  const api = new Hono();
  api.use("/projects/:id/layer-text", projectMutationGuard(reviews));
  const path = "/projects/:id/layer-text";
  const read = async (
    project: Project,
    {
      path: composition,
      absolute,
    }: Awaited<ReturnType<typeof compositionFile>>,
    clipId: string,
  ) => {
    const [source, document] = await Promise.all([
      readSource(project, composition),
      store.document(project),
    ]);
    const lockedTracks = await lockedCompositionTracks(
      project,
      composition,
      document.timelines,
    );
    const policy = previewTimingPolicy(project.path);
    policy.read(absolute, source.content);
    const staticSource = policy.contract() === "attributes";
    const inspect = (content = source.content, version = source.version) => {
      try {
        const { locked, layers, write } = inspectLayerText(
          content,
          composition,
          lockedTracks,
          clipId,
          staticSource,
        );
        const snapshot: LayerTextSnapshot = {
          composition,
          clipId,
          version,
          locked,
          layers,
        };
        return { snapshot, write };
      } catch (error) {
        if (error instanceof TimelineError)
          throw new HttpError(
            error.code === "not_found" ? 404 : 422,
            error.message,
          );
        throw error;
      }
    };
    return { source, inspect };
  };
  api.get(path, async (c) => {
    const input = parseInput(LayerTextQuerySchema, c.req.query());
    const project = await store.get(c.req.param("id"));
    const composition = await compositionFile(project, input.composition);
    const { inspect } = await read(project, composition, input.clipId);
    return c.json(inspect().snapshot);
  });
  api.post(path, async (c) => {
    const input = parseInput(LayerTextUpdateSchema, await c.req.json());
    const project = await store.get(c.req.param("id"));
    const file = await compositionFile(project, input.composition);
    const { path: composition } = file;
    const { clipId, layerId } = input;
    const label = "Edit layer text";
    const result = await reviews.editComposition(
      project,
      composition,
      c.req.header(AGENT_HEADER),
      () =>
        store.mutate(
          project,
          label,
          async () => {
            // Read the lock in the same queue as timeline changes, even if the HTML version is unchanged.
            const { source, inspect } = await read(project, file, clipId);
            if (source.version !== input.expectedVersion)
              throw new HttpError(
                409,
                "The source changed. Inspect layers again before editing.",
              );
            const current = inspect();
            if (current.snapshot.locked)
              throw new HttpError(422, "This graphic is on a locked track.");
            const target = current.snapshot.layers.find(
              ({ id }) => id === layerId,
            );
            if (!target)
              throw new HttpError(
                422,
                "This layer cannot be edited here. Use Source.",
              );
            if (target.reason) throw new HttpError(422, target.reason);
            if (target.text === input.text) return current.snapshot;

            const after = current.write(layerId, input.text);
            const next = inspect(after, fileContentVersion(after)).snapshot;
            const updated = next.layers.find(({ id }) => id === layerId);
            if (updated?.text !== input.text || updated.reason)
              throw new HttpError(
                422,
                "This edit could not preserve the layer's markup. Use Source.",
              );
            const destination = await compositionFile(project, composition);
            if (destination.path !== composition)
              throw new HttpError(
                409,
                "The composition path changed. Inspect layers again.",
              );
            store.writeFiles(project, [
              {
                sourceFile: composition,
                absPath: destination.absolute,
                before: source.content,
                after,
                expectedVersion: input.expectedVersion,
              },
            ]);
            return next;
          },
          historyWho(reviews, c, project),
        ),
      undefined,
      { label },
    );
    return c.json(result);
  });
  return api;
}
