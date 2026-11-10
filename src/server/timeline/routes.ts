import { posix } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { fileContentVersion } from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import type { Project } from "../../shared/project";
import {
  TimelineError,
  applyAll,
  canonicalTimeline,
} from "../../shared/timeline/apply";
import type { ClipOrigin } from "../../shared/timeline/apply";
import {
  CommandBatchSchema,
  TimelineSettingsSchema,
  emptyTimelineSettings,
} from "../../shared/timeline/schema";
import type {
  CommandBatch,
  TimelineSettings,
  TimelineView,
} from "../../shared/timeline/schema";
import { parseInput } from "../projects/routes";
import { projectPath, readSource } from "../projects/store";
import type { ProjectStore } from "../projects/store";
import {
  compositionScope,
  declareTrackLayer,
  mediaSources,
  parseComposition,
  patchComposition,
  settingsOf,
} from "./composition";
import { mediaLengths } from "./media";

/** One revision covers both halves of the timeline: composition HTML and its sidecar settings. */
const revisionOf = (sourceVersion: string, settings: TimelineSettings) =>
  fileContentVersion(
    `${sourceVersion}\n${JSON.stringify(TimelineSettingsSchema.parse(settings))}`,
  );

/**
 * `./index.html`, `/index.html`, and `index.html` name one composition, with one settings entry
 * and revision. Paths are project-relative, so a leading slash means the project root.
 */
const canonical = (composition: string) =>
  posix.normalize(composition.replaceAll("\\", "/")).replace(/^\/+/, "");

const refused = (c: Context, error: unknown) => {
  if (!(error instanceof TimelineError)) throw error;
  return c.json(
    { error: error.message, code: error.code, command: error.command },
    422,
  );
};

export function createTimelineRoutes(store: ProjectStore) {
  const read = async (project: Project, composition: string) => {
    const [source, document] = await Promise.all([
      readSource(project, composition),
      store.document(project),
    ]);
    const settings = document.timelines[composition] ?? emptyTimelineSettings();
    // One scope for reading, media discovery, and the readback after an edit.
    const scope = compositionScope(composition);
    const lengths = await mediaLengths(
      project,
      composition,
      mediaSources(source.content, scope),
    );
    return {
      source,
      document,
      scope,
      lengths,
      parsed: parseComposition(source.content, settings, {
        scope,
        mediaLengths: lengths,
      }),
      revision: revisionOf(source.version, settings),
    };
  };

  const edit = async (
    project: Project,
    batch: CommandBatch,
  ): Promise<TimelineView> => {
    const { composition } = batch;
    const current = await read(project, composition);
    if (current.revision !== batch.expectedRevision)
      throw new HttpError(
        409,
        "The timeline changed since it was read. Read it again before editing.",
      );
    const lengths = new Map([
      ...current.lengths,
      ...(await mediaLengths(
        project,
        composition,
        batch.commands.flatMap((command) =>
          command.type === "insert" ? [command.clip.src] : [],
        ),
      )),
    ]);
    const origins = new Map<string, ClipOrigin>();
    // Commands keep source times exact; the written timeline holds them to the microsecond.
    const timeline = canonicalTimeline(
      applyAll(current.parsed.timeline, batch.commands, {
        onCreate: (id, origin) => origins.set(id, origin),
        mediaLengths: lengths,
      }),
    );
    const html = patchComposition(current.parsed, timeline, origins);
    const settings = settingsOf(timeline);
    // The written source must read back as exactly the timeline that was applied.
    if (
      !Bun.deepEquals(
        parseComposition(html, settings, {
          scope: current.scope,
          mediaLengths: lengths,
        }).timeline,
        timeline,
      )
    )
      throw new TimelineError(
        "unsupported",
        "This edit cannot be written to the composition exactly. Edit the source instead.",
      );
    const files =
      html === current.source.content
        ? []
        : [
            {
              sourceFile: composition,
              absPath: await projectPath(project, composition),
              before: current.source.content,
              after: html,
              expectedVersion: current.source.version,
            },
          ];
    if (
      files.length &&
      composition !== "index.html" &&
      html.includes("<style data-cutroom-track-stacking=")
    ) {
      const entry = await readSource(project, "index.html");
      const declared = declareTrackLayer(entry.content);
      if (declared !== entry.content)
        files.push({
          sourceFile: "index.html",
          absPath: await projectPath(project, "index.html"),
          before: entry.content,
          after: declared,
          expectedVersion: entry.version,
        });
    }
    const { timelines } = current.document;
    if (!Bun.deepEquals(settings, settingsOf(current.parsed.timeline))) {
      if (Bun.deepEquals(settings, emptyTimelineSettings()))
        delete timelines[composition];
      else timelines[composition] = settings;
      await store.writeDocument(project, current.document, files);
    } else if (files.length) store.writeFiles(project, files);
    return {
      composition,
      revision: revisionOf(
        fileContentVersion(html),
        timelines[composition] ?? emptyTimelineSettings(),
      ),
      timeline,
    };
  };

  const api = new Hono();
  api.get("/projects/:id/timeline", async (c) => {
    const project = await store.get(c.req.param("id"));
    const composition = canonical(c.req.query("composition") ?? "index.html");
    try {
      const { parsed, revision } = await read(project, composition);
      return c.json({
        composition,
        revision,
        timeline: parsed.timeline,
      } satisfies TimelineView);
    } catch (error) {
      return refused(c, error);
    }
  });
  api.post("/projects/:id/commands", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(CommandBatchSchema, await c.req.json());
    const batch = { ...input, composition: canonical(input.composition) };
    try {
      return c.json(
        await store.mutate(project, batch.label, () => edit(project, batch)),
      );
    } catch (error) {
      return refused(c, error);
    }
  });
  return api;
}
