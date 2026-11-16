import { Hono } from "hono";
import type { Context } from "hono";
import { posix } from "node:path";
import { applyFileMutations } from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import { AGENT_HEADER } from "../../shared/review";
import { TimelineError } from "../../shared/timeline/errors";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import {
  VariableDeclareSchema,
  VariableDefaultSchema,
  VariableError,
  VariablesPreviewSchema,
  checkVariableValues,
  parseDeclarations,
} from "../../shared/variables";
import type {
  CompositionVariable,
  VariableValues,
  VariablesState,
} from "../../shared/variables";
import type { Project } from "../../shared/project";
import {
  compositionScope,
  declareVariables,
  declaredVariables,
  elementAttributes,
  parseComposition,
  setElementAttributes,
} from "../timeline/composition";
import { writeClipStyle } from "../timeline/style";
import { projectMutationGuard } from "./authorization";
import { projectWritePath } from "./path";
import type { ReviewService } from "./review";
import { historyWho, parseInput } from "./routes";
import { readSource } from "./store";
import type { ProjectStore } from "./store";

export type VariablesChange = Pick<VariablesState, "composition" | "preview">;

const compositionPath = (requested: string | undefined) => {
  const path = posix
    .normalize((requested || "index.html").replaceAll("\\", "/"))
    .replace(/^\/+/, "");
  if (path === ".." || path.startsWith("../") || !/\.html?$/i.test(path))
    throw new HttpError(400, "Name an HTML composition inside the project.");
  return path;
};

/** The declarations as written, loose entries included, so a rewrite keeps every one. */
const writtenDeclarations = (html: string): unknown[] => {
  const raw = declaredVariables(html);
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  throw new VariableError(
    "data-composition-variables is not a JSON list. Fix it in the source first.",
  );
};

const refusal = (error: unknown): never => {
  if (error instanceof VariableError || error instanceof TimelineError)
    throw new HttpError(422, error.message);
  throw error;
};

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
    const declarations = parseDeclarations(declaredVariables(source.content));
    return {
      composition,
      declarations,
      preview: accepted(
        previews.get(project.id)?.get(composition) ?? {},
        declarations,
      ),
    };
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
    change: (html: string) => string,
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
              after = change(source.content);
            } catch (error) {
              return refusal(error);
            }
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

  api.put("/projects/:id/variables/preview", async (c) => {
    const input = parseInput(VariablesPreviewSchema, await c.req.json());
    const project = await store.get(c.req.param("id"));
    const composition = compositionPath(input.composition);
    const { declarations } = await read(project, composition);
    let values: VariableValues;
    try {
      values = checkVariableValues(input.values, declarations);
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
    const variable = before.declarations.find((item) => item.id === input.id);
    if (!variable)
      throw new HttpError(
        404,
        `${composition} declares no variable ${input.id}.`,
      );
    try {
      // An empty result means the value is already the default.
      checkVariableValues({ [input.id]: input.value }, before.declarations);
    } catch (error) {
      return refusal(error);
    }
    if (input.value !== variable.default)
      await edit(
        c,
        project,
        composition,
        `Set ${variable.label} default`,
        (html) => {
          // Only the default changes; every other key and declaration stays as written.
          return declareVariables(
            html,
            JSON.stringify(
              writtenDeclarations(html).map((entry) =>
                entry &&
                typeof entry === "object" &&
                "id" in entry &&
                entry.id === input.id
                  ? { ...entry, default: input.value }
                  : entry,
              ),
            ),
          );
        },
      );
    // The preview now shows the default, so the override has done its job.
    const { [input.id]: _, ...rest } = before.preview;
    if (input.id in before.preview) setPreview(project, composition, rest);
    return c.json(await read(project, composition));
  });

  api.post("/projects/:id/variables/declare", async (c) => {
    const input = parseInput(VariableDeclareSchema, await c.req.json());
    const project = await store.get(c.req.param("id"));
    const composition = compositionPath(input.composition);
    const { variable, bind } = input;
    const source = await readSource(project, composition);
    if (
      parseDeclarations(declaredVariables(source.content)).some(
        (item) => item.id === variable.id,
      )
    )
      throw new HttpError(409, `${variable.id} is already declared.`);
    if (bind) {
      if (bind.to === "text" && variable.type !== "string")
        throw new HttpError(422, "Bind words to a string variable.");
      if (bind.to === "color" && variable.type !== "color")
        throw new HttpError(422, "Bind a text colour to a color variable.");
      const clip = parseComposition(
        source.content,
        (await store.document(project)).timelines[composition] ??
          emptyTimelineSettings(),
        { scope: compositionScope(composition) },
      ).timeline.clips.find((item) => item.id === bind.clipId);
      if (!clip || !elementAttributes(source.content, bind.clipId))
        throw new HttpError(
          404,
          `No clip in ${composition} has the element id ${bind.clipId}.`,
        );
      if (clip.kind !== "element" || clip.title)
        throw new HttpError(
          422,
          "Variables bind to text elements. A title keeps its words and colour in its own settings.",
        );
      if (
        bind.to === "text" &&
        (clip.text === null ||
          clip.text.includes("\n") ||
          clip.sourceRestrictions?.text)
      )
        // HyperFrames replaces only an element's own text, so line breaks would stay behind.
        throw new HttpError(
          422,
          clip.sourceRestrictions?.text ??
            "Only an element with one line of plain words can take a text variable.",
        );
      const bound = elementAttributes(source.content, bind.clipId)?.[
        "data-var-text"
      ];
      if (bind.to === "text" && bound)
        throw new HttpError(
          409,
          `${bind.clipId}'s words are already ${bound}.`,
        );
    }
    await edit(
      c,
      project,
      composition,
      bind ? `Bind ${variable.label}` : `Declare ${variable.label}`,
      (html) => {
        let next = declareVariables(
          html,
          JSON.stringify([...writtenDeclarations(html), variable]),
        );
        if (!bind) return next;
        const changes: [string, string][] =
          bind.to === "text"
            ? [["data-var-text", variable.id]]
            : [
                [
                  "style",
                  writeClipStyle(elementAttributes(next, bind.clipId)?.style, {
                    color: `var(--${variable.id})`,
                  })!,
                ],
              ];
        next = setElementAttributes(next, bind.clipId, changes) ?? next;
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
