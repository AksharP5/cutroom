import { Hono } from "hono";
import type { Context } from "hono";
import { stat } from "node:fs/promises";
import { posix } from "node:path";
import {
  applyFileMutations,
  fileContentVersion,
} from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import { AGENT_HEADER } from "../../shared/review";
import { TimelineError } from "../../shared/timeline/errors";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import {
  VariableDeclareSchema,
  VariableBindSchema,
  VariableDefaultSchema,
  VariableError,
  VariablesPreviewSchema,
  SceneVariablesQuerySchema,
  SceneVariableUpdateSchema,
  VariableIdSchema,
  VariableValueSchema,
  VariableValuesSchema,
  isEditable,
  variableDefaultValue,
  variableValueSchema,
  sceneImageUrl,
  checkVariableValues,
  imageVariablePath,
} from "../../shared/variables";
import type {
  CompositionVariable,
  SceneVariables,
  VariableValues,
  VariablesState,
  VariableBinding,
} from "../../shared/variables";
import type { TimelineSettings } from "../../shared/timeline/schema";
import type { Project } from "../../shared/project";
import {
  compositionScope,
  bindCompositionVariable,
  sourceVariables,
  parseComposition,
  sceneInstanceSource,
} from "../timeline/composition";
import { projectMutationGuard } from "./authorization";
import { projectWritePath } from "./path";
import { sceneSourceBase, sceneSourcePath } from "./sceneSources";
import type { ReviewService } from "./review";
import { historyWho, parseInput } from "./routes";
import { readSource } from "./store";
import type { ProjectStore } from "./store";

export type VariablesChange = Pick<VariablesState, "composition" | "preview">;

async function checkProjectImage(
  project: Project,
  composition: string,
  id: string,
  url: string,
) {
  const path = imageVariablePath(composition, url);
  const absolute = await projectWritePath(project, path, { sourceOnly: false });
  if (!(await stat(absolute)).isFile())
    throw new VariableError(`${id}: choose a project image file.`);
}

export async function checkProjectVariableValues(
  project: Project,
  composition: string,
  values: VariableValues,
  declarations: readonly CompositionVariable[],
) {
  const checked = checkVariableValues(values, declarations);
  await Promise.all(
    declarations.map(async (variable) => {
      const value = checked[variable.id];
      if (variable.type !== "image" || typeof value !== "string") return;
      await checkProjectImage(project, composition, variable.id, value);
    }),
  );
  return checked;
}

const compositionPath = (requested: string | undefined) => {
  const path = posix
    .normalize((requested || "index.html").replaceAll("\\", "/"))
    .replace(/^\/+/, "");
  if (path === ".." || path.startsWith("../") || !/\.html?$/i.test(path))
    throw new HttpError(400, "Name an HTML composition inside the project.");
  return path;
};

const refusal = (error: unknown): never => {
  if (error instanceof VariableError || error instanceof TimelineError)
    throw new HttpError(422, error.message);
  throw error;
};

function bindSource(
  html: string,
  bind: VariableBinding,
  variable: CompositionVariable,
  settings: TimelineSettings,
  composition: string,
  existing = true,
) {
  if (bind.to === "text" && variable.type !== "string")
    throw new HttpError(422, "Bind words to a string variable.");
  if (bind.to === "color" && variable.type !== "color")
    throw new HttpError(422, "Bind a text colour to a color variable.");
  if (bind.to === "image" && variable.type !== "image")
    throw new HttpError(422, "Bind an image source to an image variable.");
  const parsed = parseComposition(html, settings, {
    scope: compositionScope(composition),
  });
  if (!parsed.timeline.clips.some((clip) => clip.id === bind.clipId))
    throw new HttpError(
      404,
      `No clip in ${composition} has the element id ${bind.clipId}.`,
    );
  if (
    bind.to === "text" &&
    parsed.elements.get(bind.clipId)?.attrs["data-var-text"]
  )
    throw new HttpError(409, `${bind.clipId}'s words are already bound.`);
  return bindCompositionVariable(
    parsed,
    bind.clipId,
    bind.to,
    variable.id,
    existing,
  );
}

/**
 * Composition variables: declarations live in the source, preview overrides live here, in memory,
 * for every tab and agent to share until the server stops. They reach the preview as HyperFrames'
 * own `?variables=` and an export as its `variables`.
 */
export function createVariableRoutes(
  store: ProjectStore,
  reviews: ReviewService,
) {
  const api = new Hono();
  api.use("/projects/:id/*", projectMutationGuard(reviews));
  const previews = new Map<string, Map<string, VariableValues>>();
  const listeners = new Map<string, Set<(change: VariablesChange) => void>>();

  /** Stored overrides the current declarations still accept, one by one. */
  const accepted = (
    values: VariableValues,
    declarations: readonly CompositionVariable[],
  ) =>
    Object.fromEntries(
      Object.entries(values).filter(([id, value]) => {
        try {
          return id in checkVariableValues({ [id]: value }, declarations);
        } catch {
          return false;
        }
      }),
    );

  const read = async (
    project: Project,
    composition: string,
  ): Promise<VariablesState> => {
    const source = await readSource(project, composition);
    const { declarations } = sourceVariables(
      source.content,
      compositionScope(composition),
    );
    return {
      composition,
      declarations,
      preview: accepted(
        previews.get(project.id)?.get(composition) ?? {},
        declarations,
      ),
    };
  };

  const loadScene = async (
    project: Project,
    composition: string,
    clipId: string,
    html: string,
  ) => {
    const settings =
      (await store.document(project)).timelines[composition] ??
      emptyTimelineSettings();
    const instance = sceneInstanceSource(
      parseComposition(html, settings, {
        scope: compositionScope(composition),
      }),
      clipId,
    );
    const from = await sceneSourceBase(
      composition,
      html,
      async () => (await readSource(project)).content,
    );
    const scene = sceneSourcePath(from, instance.src);
    if (!scene)
      throw new HttpError(
        422,
        "The scene must point to an HTML file inside this project.",
      );
    const source = await readSource(project, scene);
    const { declarations, matches } = sourceVariables(
      source.content,
      "sub-composition",
    );
    const version = fileContentVersion(
      JSON.stringify([html, scene, source.version]),
    );
    return { instance, scene, declarations, matches, version };
  };

  const readScene = async (
    project: Project,
    composition: string,
    clipId: string,
  ): Promise<SceneVariables> => {
    try {
      const { content } = await readSource(project, composition);
      const { instance, scene, declarations, version } = await loadScene(
        project,
        composition,
        clipId,
        content,
      );
      const imageDefaults = Object.fromEntries(
        declarations.flatMap((variable) =>
          variable.type === "image"
            ? [[variable.id, variableDefaultValue(variable)]]
            : [],
        ),
      );
      const { rebaseImageOverrides } =
        await import("../hyperframes/imageVariables");
      const defaults = rebaseImageOverrides(project.path, scene, imageDefaults);
      const values = VariableValuesSchema.parse(
        Object.fromEntries(
          declarations.flatMap((variable) => {
            if (
              !isEditable(variable) ||
              !VariableIdSchema.safeParse(variable.id).success ||
              !Object.hasOwn(instance.values, variable.id)
            )
              return [];
            const raw = instance.values[variable.id];
            const value = VariableValueSchema.safeParse(
              variable.type === "image" ? sceneImageUrl(raw) : raw,
            );
            return value.success ? [[variable.id, value.data]] : [];
          }),
        ),
      );
      return {
        composition,
        clipId,
        scene,
        locked: instance.locked,
        version,
        values,
        declarations: declarations.map((variable) => {
          const url = defaults[variable.id];
          return variable.type === "image" && typeof url === "string"
            ? {
                ...variable,
                default:
                  typeof variable.default === "string"
                    ? url
                    : { ...variable.default, url },
              }
            : variable;
        }),
      };
    } catch (error) {
      return refusal(error);
    }
  };

  const setPreview = (
    project: Project,
    composition: string,
    values: VariableValues,
  ) => {
    const compositions = previews.get(project.id) ?? new Map();
    previews.set(project.id, compositions);
    if (Object.keys(values).length) compositions.set(composition, values);
    else compositions.delete(composition);
    for (const listener of listeners.get(project.id) ?? [])
      listener({ composition, preview: values });
  };

  /** One history step that rewrites the composition source. */
  const edit = (
    c: Context,
    project: Project,
    composition: string,
    label: string,
    change: (html: string) => string | Promise<string>,
  ) =>
    reviews.editComposition(
      project,
      composition,
      c.req.header(AGENT_HEADER),
      () =>
        store.mutate(
          project,
          label,
          async () => {
            const source = await readSource(project, composition);
            let after: string;
            try {
              after = await change(source.content);
            } catch (error) {
              return refusal(error);
            }
            if (after === source.content) return;
            applyFileMutations(project.path, [
              {
                sourceFile: composition,
                absPath: await projectWritePath(project, composition),
                before: source.content,
                after,
                expectedVersion: source.version,
              },
            ]);
          },
          historyWho(reviews, c, project),
        ),
    );

  api.get("/projects/:id/variables", async (c) => {
    const project = await store.get(c.req.param("id"));
    return c.json(
      await read(project, compositionPath(c.req.query("composition"))),
    );
  });

  api.get("/projects/:id/variables/instance", async (c) => {
    const input = parseInput(SceneVariablesQuerySchema, c.req.query());
    const project = await store.get(c.req.param("id"));
    return c.json(
      await readScene(
        project,
        compositionPath(input.composition),
        input.clipId,
      ),
    );
  });

  api.put("/projects/:id/variables/instance", async (c) => {
    const input = parseInput(SceneVariableUpdateSchema, await c.req.json());
    const { clipId, id } = input;
    const project = await store.get(c.req.param("id"));
    const composition = compositionPath(input.composition);
    await edit(
      c,
      project,
      composition,
      input.value === null
        ? `Reset ${id} on ${clipId}`
        : `Set ${id} on ${clipId}`,
      async (html) => {
        const { instance, matches, version } = await loadScene(
          project,
          composition,
          clipId,
          html,
        );
        if (instance.locked)
          throw new HttpError(422, "The scene clip's track is locked.");
        if (
          input.expectedVersion !== undefined &&
          input.expectedVersion !== version
        )
          throw new HttpError(
            409,
            "The scene changed. Inspect its variables again.",
          );
        const [variable, duplicate] = matches(id);
        if (!variable || duplicate || !isEditable(variable))
          throw new VariableError(
            `${id} must name one editable variable in the mounted scene.`,
          );
        const previous = instance.values[id];
        if (input.value === null) {
          if (!Object.hasOwn(instance.values, id)) return html;
          const { [id]: _, ...remaining } = instance.values;
          return instance.write(remaining);
        }
        const next = variableValueSchema(variable).safeParse(input.value);
        if (!next.success)
          throw new VariableError(
            `${id}: ${next.error.issues.map((issue) => issue.message).join(" ")}`,
          );
        if (variable.type === "image" && typeof next.data === "string") {
          await checkProjectImage(project, "index.html", id, next.data);
          if (sceneImageUrl(previous) === next.data) return html;
          const shape = previous ?? variable.default;
          const value =
            shape && typeof shape === "object" && "url" in shape
              ? { ...shape, url: next.data }
              : next.data;
          return instance.write({ ...instance.values, [id]: value });
        }
        return Object.hasOwn(instance.values, id) && previous === next.data
          ? html
          : instance.write({ ...instance.values, [id]: next.data });
      },
    );
    return c.json(await readScene(project, composition, clipId));
  });

  api.put("/projects/:id/variables/preview", async (c) => {
    const input = parseInput(VariablesPreviewSchema, await c.req.json());
    const project = await store.get(c.req.param("id"));
    const composition = compositionPath(input.composition);
    const { declarations } = await read(project, composition);
    let values: VariableValues;
    try {
      values = await checkProjectVariableValues(
        project,
        composition,
        input.values,
        declarations,
      );
    } catch (error) {
      return refusal(error);
    }
    setPreview(project, composition, values);
    return c.json(await read(project, composition));
  });

  api.post("/projects/:id/variables/default", async (c) => {
    const input = parseInput(VariableDefaultSchema, await c.req.json());
    const project = await store.get(c.req.param("id"));
    const composition = compositionPath(input.composition);
    const before = await read(project, composition);
    const label = before.declarations.find(
      (item) => item.id === input.id,
    )?.label;
    await edit(
      c,
      project,
      composition,
      `Set ${label ?? input.id} default`,
      async (html) => {
        const variables = sourceVariables(html, compositionScope(composition));
        const matches = variables.matches(input.id);
        const [variable] = matches;
        if (!variable)
          throw new HttpError(
            404,
            `${composition} declares no variable ${input.id}.`,
          );
        if (matches.length > 1)
          throw new HttpError(
            422,
            `${input.id} must name one declared variable.`,
          );
        const changed = await checkProjectVariableValues(
          project,
          composition,
          { [input.id]: input.value },
          matches,
        );
        if (!Object.hasOwn(changed, input.id)) return html;
        return variables.setDefault(variable, input.value);
      },
    );
    const latest = previews.get(project.id)?.get(composition);
    // Clear the promoted override without replacing a preview another client just set.
    if (latest && Object.hasOwn(latest, input.id)) {
      const { [input.id]: current, ...rest } = latest;
      if (current === before.preview[input.id] || current === input.value)
        setPreview(project, composition, rest);
    }
    return c.json(await read(project, composition));
  });

  api.post("/projects/:id/variables/bind", async (c) => {
    const input = parseInput(VariableBindSchema, await c.req.json());
    const project = await store.get(c.req.param("id"));
    const composition = compositionPath(input.composition);
    await edit(c, project, composition, `Bind ${input.id}`, async (html) => {
      const matches = sourceVariables(
        html,
        compositionScope(composition),
      ).matches(input.id);
      if (matches.length !== 1)
        throw new HttpError(
          422,
          `${input.id} must name one declared variable.`,
        );
      return bindSource(
        html,
        input.bind,
        matches[0]!,
        (await store.document(project)).timelines[composition] ??
          emptyTimelineSettings(),
        composition,
      );
    });
    return c.json(await read(project, composition));
  });

  api.post("/projects/:id/variables/declare", async (c) => {
    const input = parseInput(VariableDeclareSchema, await c.req.json());
    const project = await store.get(c.req.param("id"));
    const composition = compositionPath(input.composition);
    const { variable, bind } = input;
    await edit(
      c,
      project,
      composition,
      bind ? `Bind ${variable.label}` : `Declare ${variable.label}`,
      async (html) => {
        const variables = sourceVariables(html, compositionScope(composition));
        if (variables.matches(variable.id).length)
          throw new HttpError(409, `${variable.id} is already declared.`);
        if (variable.type === "image")
          await checkProjectImage(
            project,
            composition,
            variable.id,
            variable.default,
          );
        const next = variables.add(variable);
        if (bind)
          return bindSource(
            next,
            bind,
            variable,
            (await store.document(project)).timelines[composition] ??
              emptyTimelineSettings(),
            composition,
            false,
          );
        return next;
      },
    );
    return c.json(await read(project, composition), 201);
  });

  return Object.assign(api, {
    /** The open composition's overrides as they change, for the editor's project connection. */
    subscribe(projectId: string, listener: (change: VariablesChange) => void) {
      const set = listeners.get(projectId) ?? new Set();
      listeners.set(projectId, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(projectId);
      };
    },
  });
}
