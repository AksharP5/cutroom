import { projectMutationGuard } from "../projects/authorization";
import { AGENT_HEADER } from "../../shared/review";
import type { ReviewService } from "../projects/review";
import { posix } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  createProjectSignatureAsync,
  fileContentVersion,
} from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import type { Project } from "../../shared/project";
import {
  TimelineError,
  applyAll,
  canonicalTimeline,
  randomClipId,
} from "../../shared/timeline/apply";
import type { ClipOrigin } from "../../shared/timeline/apply";
import {
  CommandBatchSchema,
  TimelineSettingsSchema,
  emptyTimelineSettings,
} from "../../shared/timeline/schema";
import type {
  CommandBatch,
  Command,
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
  applyTrackMix,
  declareTrackLayer,
  mediaSources,
  parseComposition,
  patchComposition,
  settingsOf,
} from "./composition";
import { mediaFacts } from "./media";
import { readTrackMix } from "./mix";
import { createPositionSupport } from "./positionSupport";
import type { PositionSupport } from "./positionSupport";

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
  positions: PositionSupport = createPositionSupport(),
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

  const support = async (
    project: Project,
    composition: string,
    current: Awaited<ReturnType<typeof read>>,
    clipId: string,
    scope = `${project.id}\0${composition}`,
  ) => {
    const clip = current.parsed.timeline.clips.find(
      (clip) => clip.id === clipId,
    );
    if (!clip)
      throw new TimelineError("unsupported", "The clip no longer exists.");
    const shifted = {
      ...current.parsed.timeline,
      clips: current.parsed.timeline.clips.map((item) =>
        item.id === clipId
          ? { ...item, x: (item.x ?? 0) + 37, y: (item.y ?? 0) + 23 }
          : item,
      ),
    };
    return positions.check(
      scope,
      current.revision,
      {
        projectDir: project.path,
        overrides: Object.fromEntries(
          (await readTrackMix(store, project)).map(({ path, html }) => [
            path,
            html,
          ]),
        ),
        composition,
        clipId,
        sources: [
          applyTrackMix(current.parsed),
          patchComposition(current.parsed, shifted, new Map()),
        ],
        start: clip.start,
        end: clip.start + clip.duration,
        fps: shifted.fps,
        width: Number(current.parsed.root.attrs["data-width"]) || 1920,
        height: Number(current.parsed.root.attrs["data-height"]) || 1080,
      },
      await createProjectSignatureAsync(project.path),
    );
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
    const origins = new Map<string, ClipOrigin>();
    const generatedIds: string[] = [];
    // Commands keep source times exact; the written timeline holds them to the microsecond.
    const timeline = canonicalTimeline(
      applyAll(current.parsed.timeline, batch.commands, {
        onCreate: (id, origin) => origins.set(id, origin),
        newId: (base, from, taken) => {
          const id = randomClipId(base, from, taken);
          generatedIds.push(id);
          return id;
        },
        mediaLengths: lengths,
        silentMedia: inserted.silent,
        // No new clip takes an id the project used before, even one undone since.
        retired: await usedClipIds(project),
      }),
    );
    const html = patchComposition(current.parsed, timeline, origins);
    const settings = settingsOf(timeline);
    const written = parseComposition(html, settings, {
      scope: current.scope,
      mediaLengths: lengths,
    });
    const positionCommands = batch.commands.flatMap((command, index) =>
      command.type === "setClip" &&
      (command.x !== undefined || command.y !== undefined)
        ? [{ command, index }]
        : [],
    );
    if (positionCommands.length) {
      // Validate newly split/inserted pieces and other commands in the batch, before writing.
      // Ordinary Position commits use the same revision/key as the selection's pending check.
      const baseCommands = batch.commands.flatMap((command): Command[] => {
        if (command.type !== "setClip") return [command];
        const { x: _x, y: _y, ...rest } = command;
        return Object.keys(rest).length === 2 ? [] : [rest];
      });
      let nextId = 0;
      const base = canonicalTimeline(
        applyAll(current.parsed.timeline, baseCommands, {
          // Replaying without x/y must retain the ids already chosen for this batch.
          newId: () => generatedIds[nextId++]!,
          mediaLengths: lengths,
          silentMedia: inserted.silent,
        }),
      );
      const baseHtml = baseCommands.length
        ? patchComposition(current.parsed, base, origins)
        : current.source.content;
      const baseSettings = settingsOf(base);
      const candidate =
        baseHtml === current.source.content &&
        Bun.deepEquals(baseSettings, settingsOf(current.parsed.timeline))
          ? current
          : {
              ...current,
              source: { ...current.source, content: baseHtml },
              parsed: parseComposition(baseHtml, baseSettings, {
                scope: current.scope,
                mediaLengths: lengths,
              }),
              revision: revisionOf(fileContentVersion(baseHtml), baseSettings),
            };
      // An uncommitted split/move has its own document. Ordinary timeline reads must
      // not supersede that check merely because they still see the saved revision.
      const scope = `${project.id}\0${composition}${candidate === current ? "" : `\0${candidate.revision}`}`;
      try {
        for (const { command, index } of positionCommands) {
          const reason = await support(
            project,
            composition,
            candidate,
            command.clipId,
            scope,
          );
          if (reason) throw new TimelineError("unsupported", reason, index);
        }
      } finally {
        if (candidate !== current) positions.forget(scope);
      }
      // Source writes outside the mutation queue must not land over a checked document.
      if ((await read(project, composition)).revision !== current.revision)
        throw new HttpError(
          409,
          "The timeline changed during the Position check. Read it again.",
        );
    }
    // The written source must read back as exactly the timeline that was applied.
    if (!Bun.deepEquals(written.timeline, timeline))
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
      timeline,
      positionUnsupported: {},
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
        positionUnsupported: positions.reasons(
          `${project.id}\0${composition}`,
          revision,
        ),
        ...(await reviews.clipChanges(project, composition)),
      } satisfies TimelineView);
    } catch (error) {
      return refused(c, error);
    }
  });
  api.get("/projects/:id/position-support", async (c) => {
    const project = await store.get(c.req.param("id"));
    const composition = canonical(c.req.query("composition") ?? "index.html");
    const clipId = c.req.query("clipId");
    if (!clipId) throw new HttpError(400, "Choose a clip to check Position.");
    const current = await read(project, composition);
    if (current.revision !== c.req.query("revision"))
      throw new HttpError(409, "The timeline changed. Read it again.");
    if (!current.parsed.timeline.clips.some((clip) => clip.id === clipId))
      throw new HttpError(409, "The clip changed. Read the timeline again.");
    const reason = await support(project, composition, current, clipId);
    return c.json({ reason });
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
  return Object.assign(api, { dispose: () => positions.close() });
}
