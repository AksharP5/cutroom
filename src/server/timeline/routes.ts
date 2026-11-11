import { projectMutationGuard } from "../projects/authorization";
import { AGENT_HEADER } from "../../shared/review";
import type { ReviewService } from "../projects/review";
import { posix } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { fileContentVersion } from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import type { Project, ProjectSummary } from "../../shared/project";
import {
  TimelineError,
  applyAll,
  canonicalTimeline,
  toSeconds,
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
import { recordClipIds, usedClipIds } from "../projects/ids";
import { parseInput } from "../projects/routes";
import { readSource } from "../projects/store";
import { editLabel } from "../../shared/timeline/labels";
import { projectWritePath } from "../projects/path";
import type { ProjectStore } from "../projects/store";
import {
  compositionScope,
  declareTrackLayer,
  mediaSources,
  parseComposition,
  patchComposition,
  timelineContent,
  settingsOf,
} from "./composition";
import { mediaFacts } from "./media";

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

export function createTimelineRoutes(
  store: ProjectStore,
  reviews: ReviewService,
) {
  const read = async (project: Project, composition: string) => {
    const [source, document] = await Promise.all([
      readSource(project, composition),
      store.document(project),
    ]);
    const settings = document.timelines[composition] ?? emptyTimelineSettings();
    // One scope for reading, media discovery, and the readback after an edit.
    const scope = compositionScope(composition);
    const { lengths } = await mediaFacts(
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
    const inserted = await mediaFacts(
      project,
      composition,
      batch.commands.flatMap((command) =>
        command.type === "insert" ? [command.clip.src] : [],
      ),
    );
    const lengths = new Map([...current.lengths, ...inserted.lengths]);
    const skippedClips = new Map<
      string,
      NonNullable<TimelineView["skippedClips"]>[number]
    >();
    const origins = new Map<string, ClipOrigin>();
    // Commands keep source times exact; the written timeline holds them to the microsecond.
    const timeline = canonicalTimeline(
      applyAll(current.parsed.timeline, batch.commands, {
        onCreate: (id, origin) => origins.set(id, origin),
        onSkip: (clip, reason) =>
          skippedClips.set(clip.id, {
            clipId: clip.id,
            label: clip.label,
            reason,
          }),
        mediaLengths: lengths,
        silentMedia: inserted.silent,
        // No new clip takes an id the project used before, even one undone since.
        retired: await usedClipIds(project),
      }),
    );
    const html = patchComposition(current.parsed, timeline, origins);
    const settings = settingsOf(timeline);
    // Compare authored content; removing markup can change the remaining source restrictions.
    const written = parseComposition(html, settings, {
      scope: current.scope,
      mediaLengths: lengths,
    }).timeline;
    if (!Bun.deepEquals(timelineContent(written), timelineContent(timeline)))
      throw new TimelineError(
        "unsupported",
        "This edit cannot be written to the composition exactly. Edit the source instead.",
      );
    // Recorded before the write, so an id is spent even if the write fails.
    await recordClipIds(
      project,
      [current.parsed.timeline, timeline].flatMap(({ clips }) =>
        clips.map((clip) => clip.id),
      ),
    );
    const files =
      html === current.source.content
        ? []
        : [
            {
              sourceFile: composition,
              absPath: await projectWritePath(project, composition),
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
          absPath: await projectWritePath(project, "index.html"),
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
      timeline: written,
      ...(skippedClips.size && { skippedClips: [...skippedClips.values()] }),
    };
  };

  const api = new Hono();
  api.use("/projects/:id/*", projectMutationGuard(reviews));
  api.get("/projects/:id/timeline", async (c) => {
    const project = await store.get(c.req.param("id"));
    const composition = canonical(c.req.query("composition") ?? "index.html");
    try {
      const { parsed, revision } = await read(project, composition);
      return c.json({
        composition,
        revision,
        timeline: parsed.timeline,
        ...(await reviews.clipChanges(project, composition)),
      } satisfies TimelineView);
    } catch (error) {
      return refused(c, error);
    }
  });
  api.get("/projects/:id/summary", async (c) => {
    const project = await store.get(c.req.param("id"));
    try {
      const { timeline, root } = (await read(project, "index.html")).parsed;
      // The preview and frame capture render a composition without a size at 1920 x 1080.
      const size = (name: string, fallback: number) => {
        const value = Number(root.attrs[name]);
        return Number.isFinite(value) && value > 0 ? value : fallback;
      };
      return c.json({
        width: size("data-width", 1920),
        height: size("data-height", 1080),
        duration: toSeconds(timeline.duration, timeline.fps),
      } satisfies ProjectSummary);
    } catch (error) {
      return refused(c, error);
    }
  });
  api.post("/projects/:id/commands", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(CommandBatchSchema, await c.req.json());
    const composition = canonical(input.composition);
    try {
      // Agents may omit the label; the edit is then named from its commands, as the editor names its own.
      const label =
        input.label ??
        editLabel(
          input.commands,
          (await read(project, composition)).parsed.timeline,
          "Edited timeline",
        );
      const batch = { ...input, composition, label };
      return c.json({
        ...(await reviews.editComposition(
          project,
          batch.composition,
          c.req.header(AGENT_HEADER),
          () =>
            store.mutate(
              project,
              batch.label,
              () => edit(project, batch),
              c.req.header(AGENT_HEADER)
                ? { kind: "agent", name: "Agent" }
                : undefined,
            ),
          batch.noteId,
        )),
        ...(await reviews.clipChanges(project, batch.composition)),
      });
    } catch (error) {
      return refused(c, error);
    }
  });
  return api;
}
