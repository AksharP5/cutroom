import { extname } from "node:path";
import { stat } from "node:fs/promises";
import {
  SourceMarksSaveSchema,
  TimelineViewSettingsSchema,
} from "../../shared/timeline/view";
import type { TimelineViewSettings } from "../../shared/timeline/view";
import { destinationTracks, shownTracks } from "../../shared/timeline/tracks";
import { projectViews } from "../projects/view";
import { projectMutationGuard } from "../projects/authorization";
import {
  AGENT_HEADER,
  AGENT_NAME_HEADER,
  AgentNameSchema,
} from "../../shared/review";
import type { ReviewService } from "../projects/review";
import type { z } from "zod";
import { posix } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { fileContentVersion } from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import type { Project, ProjectSummary } from "../../shared/project";
import {
  TimelineError,
  applyAll,
  animationOrigin,
  canonicalSeconds,
  canonicalTimeline,
  toSeconds,
  copyClips,
} from "../../shared/timeline/apply";
import type { ClipOrigin } from "../../shared/timeline/apply";
import {
  AnimationFeedbackSchema,
  EDIT_SUMMARY_HEADER,
  TAB_ORIGIN_HEADER,
  TabOriginSchema,
  CommandBatchSchema,
  CopyClipsSchema,
  TimelineSettingsSchema,
  emptyTimelineSettings,
} from "../../shared/timeline/schema";
import type {
  CommandBatch,
  TimelineSettings,
  TimelineView,
  Track,
} from "../../shared/timeline/schema";
import { recordClipIds, usedClipIds } from "../projects/ids";
import { parseInput } from "../projects/routes";
import { isMissing, readSource } from "../projects/store";
import {
  STILL_SECONDS,
  stillMediaExtensions,
  localMediaPath,
} from "../../shared/media";
import { editLabel, joinEditLabels } from "../../shared/timeline/labels";
import { projectPath, projectWritePath } from "../projects/path";
import type { ProjectStore } from "../projects/store";
import {
  compositionScope,
  rebaseClipboard,
  declareTrackLayer,
  mediaSources,
  parseComposition,
  patchComposition,
  timelineContent,
  settingsOf,
} from "./composition";
import type { ParsedComposition } from "./composition";
import { animationFeedback } from "./animationFeedback";
import { mediaFacts } from "./media";
import { declaredFonts } from "./titles";

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
  const listeners = new Map<
    string,
    Set<(feedback: z.infer<typeof AnimationFeedbackSchema>) => void>
  >();
  const clipboards = new Map<
    string,
    {
      projectId: string;
      composition: string;
      clipIds: string[];
      parsed: ParsedComposition;
    }
  >();
  const views = projectViews;
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

  const prepareEdit = async (
    project: Project,
    batch: CommandBatch,
    agent: boolean,
  ) => {
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
        command.type === "insert" && command.clip.kind !== "title"
          ? [command.clip.src]
          : [],
      ),
    );
    const lengths = new Map([...current.lengths, ...inserted.lengths]);
    // A font no rule declares would fall back to a system face that export may not share.
    const fonts = new Set(
      batch.commands.flatMap((command) => {
        const font =
          command.type === "setClip"
            ? command.title?.font
            : command.type === "insert" && command.clip.kind === "title"
              ? command.clip.title.font
              : undefined;
        return font ? [font] : [];
      }),
    );
    if (fonts.size) {
      const declared = new Set([
        ...declaredFonts(current.source.content),
        ...(composition === "index.html"
          ? []
          : declaredFonts((await readSource(project, "index.html")).content)),
      ]);
      const missing = [...fonts].find((font) => !declared.has(font));
      if (missing !== undefined)
        throw new TimelineError(
          "unsupported",
          declared.size
            ? `No @font-face rule in this project declares "${missing}". Declared fonts: ${[...declared].join(", ")}.`
            : `No @font-face rule in this project declares "${missing}", or any other font. Leave the title's font unset.`,
        );
    }
    const skippedClips = new Map<
      string,
      NonNullable<TimelineView["skippedClips"]>[number]
    >();
    const snapshots = new Map<string, ParsedComposition>();
    for (const command of batch.commands) {
      if (command.type !== "paste") continue;
      const snapshot = clipboards.get(command.clipboardId);
      if (!snapshot || snapshot.projectId !== project.id)
        throw new TimelineError(
          "not_found",
          "The clip clipboard is unavailable in this project. Copy the clips again.",
        );
      if (
        !Bun.deepEquals(
          snapshot.parsed.timeline.fps,
          current.parsed.timeline.fps,
        )
      )
        throw new TimelineError(
          "unsupported",
          "Paste requires timelines with the same frame rate.",
        );
      const rebased = rebaseClipboard(
        snapshot.parsed,
        snapshot.composition,
        composition,
      );
      snapshots.set(command.clipboardId, {
        ...rebased,
        timeline: {
          ...rebased.timeline,
          clips: rebased.timeline.clips.filter((clip) =>
            snapshot.clipIds.includes(clip.id),
          ),
        },
      });
    }
    for (const parsed of snapshots.values())
      for (const clip of parsed.timeline.clips)
        if (clip.src !== null && clip.sourceDuration !== null)
          lengths.set(clip.src, clip.sourceDuration);
    const origins = new Map<string, ClipOrigin>();
    const shifts = new Map<string, number>();
    const labels: string[] = [];
    const summaries: string[] = [];
    const hasScript = [current.parsed, ...snapshots.values()].some((source) =>
      /<script\b/i.test(source.html),
    );
    // Commands keep source times exact; the written timeline holds them to the microsecond.
    const timeline = canonicalTimeline(
      applyAll(current.parsed.timeline, batch.commands, {
        onCreate: (id, origin) => origins.set(id, origin),
        onApply: (before, after, command) => {
          labels.push(editLabel([command], before, "Edited timeline"));
          summaries.push(
            editLabel([command], before, "Edited timeline", "done"),
          );
          if (!hasScript) return;
          const previous = new Map(before.clips.map((clip) => [clip.id, clip]));
          for (const clip of after.clips) {
            const old = previous.get(clip.id);
            if (!old) continue;
            const delta = canonicalSeconds(
              animationOrigin(clip, after.fps) -
                animationOrigin(old, before.fps),
            );
            if (delta)
              shifts.set(
                clip.id,
                canonicalSeconds((shifts.get(clip.id) ?? 0) + delta),
              );
          }
        },
        onSkip: (clip, reason) =>
          skippedClips.set(clip.id, {
            clipId: clip.id,
            label: clip.label,
            reason,
          }),
        clipboards: new Map(
          [...snapshots].map(([id, parsed]) => [id, parsed.timeline.clips]),
        ),
        mediaLengths: lengths,
        silentMedia: inserted.silent,
        // No new clip takes an id the project used before, even one undone since.
        retired: await usedClipIds(project),
      }),
    );
    const html = patchComposition(current.parsed, timeline, origins, snapshots);
    const settings = settingsOf(timeline);
    // Compare authored content; removing markup can change the remaining source restrictions.
    const writtenSource = parseComposition(html, settings, {
      scope: current.scope,
      mediaLengths: lengths,
    });
    const written = writtenSource.timeline;
    if (!Bun.deepEquals(timelineContent(written), timelineContent(timeline)))
      throw new TimelineError(
        "unsupported",
        "This edit cannot be written to the composition exactly. Edit the source instead.",
      );
    const detectAnimation = () =>
      animationFeedback(
        current.parsed,
        writtenSource,
        shifts,
        origins,
        snapshots,
        async (src) => {
          const path = localMediaPath(composition, src);
          if (path === null) return null;
          const source = await readSource(project, path).catch((error) => {
            if (
              isMissing(error) ||
              (error instanceof HttpError && error.status < 500) ||
              (error instanceof Error &&
                "code" in error &&
                ["EACCES", "EPERM"].includes(String(error.code)))
            )
              return null;
            throw error;
          });
          return source?.content ?? null;
        },
      );
    const agentLabel =
      agent && batch.label ? `; Agent label: "${batch.label}"` : "";
    const label = agent
      ? joinEditLabels(labels, "Edited timeline") + agentLabel
      : (batch.label ?? joinEditLabels(labels, "Edited timeline"));
    const summary = joinEditLabels(summaries, "Edited timeline") + agentLabel;
    // Encode before any project write or history window. A label failure cannot follow a saved edit.
    const encodedSummary = encodeURIComponent(summary);
    return {
      label,
      summary,
      encodedSummary,
      save: async () => {
        // Preparation precedes the store queue; preserve other metadata saved while it waited.
        const document = await store.document(project);
        const { timelines } = document;
        if (
          revisionOf(
            current.source.version,
            timelines[composition] ?? emptyTimelineSettings(),
          ) !== batch.expectedRevision
        )
          throw new HttpError(
            409,
            "The timeline changed since it was read. Read it again before editing.",
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
        // Persist inferred tracks too, before their last source clip can disappear on the next read.
        if (
          !Bun.deepEquals(
            settings,
            timelines[composition] ?? emptyTimelineSettings(),
          )
        ) {
          if (Bun.deepEquals(settings, emptyTimelineSettings()))
            delete timelines[composition];
          else timelines[composition] = settings;
          await store.writeDocument(project, document, files);
        } else if (files.length) store.writeFiles(project, files);
        return {
          composition,
          revision: revisionOf(
            fileContentVersion(html),
            timelines[composition] ?? emptyTimelineSettings(),
          ),
          timeline: written,
          detectAnimation,
          ...(skippedClips.size && {
            skippedClips: [...skippedClips.values()],
          }),
        };
      },
    };
  };

  const api = new Hono();
  api.use("/projects/:id/*", projectMutationGuard(reviews));
  api.get("/projects/:id/timeline", async (c) => {
    const project = await store.get(c.req.param("id"));
    const composition = canonical(c.req.query("composition") ?? "index.html");
    try {
      return c.json(
        await reviews.readComposition(project, composition, async () => {
          const { parsed, revision } = await read(project, composition);
          return {
            composition,
            revision,
            timeline: parsed.timeline,
          } satisfies TimelineView;
        }),
      );
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
  api.post("/projects/:id/timeline/copy", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(CopyClipsSchema, await c.req.json());
    try {
      const current = await read(project, canonical(input.composition));
      if (current.revision !== input.expectedRevision)
        throw new HttpError(409, "The timeline changed. Copy the clips again.");
      const clips = copyClips(current.parsed.timeline, input.clipIds);
      const id = crypto.randomUUID();
      clipboards.set(id, {
        projectId: project.id,
        composition: canonical(input.composition),
        clipIds: clips.map((clip) => clip.id),
        parsed: current.parsed,
      });
      return c.json({ id, clips });
    } catch (error) {
      return refused(c, error);
    }
  });
  const sourceIdentity = async (project: Project, path: string) => {
    const absolute = await projectPath(project, path);
    const info = await stat(absolute);
    if (!info.isFile()) throw new HttpError(400, "Choose a media file.");
    const still = stillMediaExtensions.some(
      (extension) => `.${extension}` === extname(path).toLowerCase(),
    );
    const src = canonical(path).split("/").map(encodeURIComponent).join("/");
    const duration = still
      ? STILL_SECONDS
      : (await mediaFacts(project, "index.html", [src])).lengths.get(src);
    if (duration === undefined)
      throw new HttpError(422, "The media duration could not be read.");
    return { size: info.size, duration };
  };
  api.get("/projects/:id/source-marks", async (c) => {
    const project = await store.get(c.req.param("id"));
    const path = c.req.query("path") ?? "";
    const identity = await sourceIdentity(project, path);
    return c.json({
      identity,
      ...(await views.readSource(project, canonical(path), identity)),
    });
  });
  api.put("/projects/:id/source-marks", async (c) => {
    const project = await store.get(c.req.param("id"));
    const path = c.req.query("path") ?? "";
    const entry = parseInput(SourceMarksSaveSchema, await c.req.json());
    const identity = await sourceIdentity(project, path);
    if (!Bun.deepEquals(entry.identity, identity))
      throw new HttpError(
        409,
        "The source media changed. Reopen it before saving marks.",
      );
    await views.saveSource(project, canonical(path), entry);
    return c.json(entry);
  });
  api.get("/projects/:id/timeline-view", async (c) => {
    const project = await store.get(c.req.param("id"));
    const composition = canonical(c.req.query("composition") ?? "index.html");
    await readSource(project, composition);
    return c.json(await views.read(project, composition));
  });
  api.put("/projects/:id/timeline-view", async (c) => {
    const project = await store.get(c.req.param("id"));
    const composition = canonical(c.req.query("composition") ?? "index.html");
    await readSource(project, composition);
    const settings = parseInput(TimelineViewSettingsSchema, await c.req.json());
    await views.save(project, composition, settings);
    return c.json(settings);
  });
  // Destinations by themselves, for agents: other view preferences stay as the editor left them.
  const destinations = async (project: Project, composition: string) => {
    const [{ parsed }, settings] = await Promise.all([
      read(project, composition),
      views.read(project, composition),
    ]);
    return { tracks: shownTracks(parsed.timeline.tracks), settings };
  };
  const destinationIndexes = (
    tracks: readonly Track[],
    settings: TimelineViewSettings,
  ) => {
    const { video, audio, videoEnabled, audioEnabled } = destinationTracks(
      tracks,
      settings.destinations,
    );
    return {
      video: video.index,
      audio: audio.index,
      videoEnabled,
      audioEnabled,
    };
  };
  api.get("/projects/:id/timeline-destinations", async (c) => {
    const project = await store.get(c.req.param("id"));
    const composition = canonical(c.req.query("composition") ?? "index.html");
    try {
      const { tracks, settings } = await destinations(project, composition);
      return c.json(destinationIndexes(tracks, settings));
    } catch (error) {
      return refused(c, error);
    }
  });
  api.put("/projects/:id/timeline-destinations", async (c) => {
    const project = await store.get(c.req.param("id"));
    const composition = canonical(c.req.query("composition") ?? "index.html");
    const chosen = parseInput(
      TimelineViewSettingsSchema.shape.destinations,
      await c.req.json(),
    );
    try {
      const { tracks, settings } = await destinations(project, composition);
      for (const kind of ["video", "audio"] as const)
        if (
          chosen[kind] !== undefined &&
          !tracks.some(
            (track) => track.kind === kind && track.index === chosen[kind],
          )
        )
          throw new TimelineError(
            "not_found",
            `Track ${chosen[kind]} is not ${kind === "audio" ? "an" : "a"} ${kind} track on this timeline.`,
          );
      const next = {
        ...settings,
        destinations: { ...settings.destinations, ...chosen },
      };
      await views.save(project, composition, next);
      return c.json(destinationIndexes(tracks, next));
    } catch (error) {
      return refused(c, error);
    }
  });
  api.post("/projects/:id/commands", async (c) => {
    const project = await store.get(c.req.param("id"));
    const input = parseInput(CommandBatchSchema, await c.req.json());
    const composition = canonical(input.composition);
    try {
      const batch = { ...input, composition };
      const origin =
        parseInput(
          TabOriginSchema.optional(),
          c.req.header(TAB_ORIGIN_HEADER),
        ) ?? null;
      const {
        view: { detectAnimation, ...result },
        encodedSummary,
      } = await reviews.editComposition(
        project,
        batch.composition,
        c.req.header(AGENT_HEADER),
        async () => {
          const prepared = await prepareEdit(
            project,
            batch,
            !!c.req.header(AGENT_HEADER),
          );
          const result = await store.mutate(
            project,
            prepared.label,
            prepared.save,
            c.req.header(AGENT_HEADER)
              ? {
                  kind: "agent",
                  name:
                    reviews.agent(project, c.req.header(AGENT_HEADER)).turn
                      .name ??
                    parseInput(
                      AgentNameSchema,
                      decodeURIComponent(
                        c.req.header(AGENT_NAME_HEADER) ?? "Agent",
                      ),
                    ),
                }
              : undefined,
          );
          return {
            view: result,
            summary: prepared.summary,
            encodedSummary: prepared.encodedSummary,
          };
        },
        batch.noteId,
        { label: (result) => result.summary },
      );
      const response = {
        ...result,
        ...(await reviews.clipChanges(project, batch.composition)),
      };
      // Beside the view, not in it: an edit answers with exactly what a read returns.
      c.header(EDIT_SUMMARY_HEADER, encodedSummary);
      const followup = async () => {
        // Give the committed edit's response a turn to flush before running source inspection.
        await Bun.sleep(0);
        const feedback = {
          origin,
          revision: response.revision,
          composition,
          clips: await detectAnimation(),
        };
        for (const listener of listeners.get(project.id) ?? [])
          listener(feedback);
        return feedback;
      };
      if (c.req.header("accept") === "text/event-stream")
        return streamSSE(c, async (stream) => {
          await stream.writeSSE({
            event: "result",
            data: JSON.stringify(response),
          });
          const feedback = await followup();
          await stream.writeSSE({
            event: "animation-left-behind",
            data: JSON.stringify(feedback),
          });
        });
      setTimeout(() => {
        void followup().catch((error: unknown) =>
          console.error("Animation feedback failed:", error),
        );
      }, 0);
      return c.json(response);
    } catch (error) {
      return refused(c, error);
    }
  });
  return Object.assign(api, {
    subscribeAnimationFeedback(
      projectId: string,
      listener: (feedback: z.infer<typeof AnimationFeedbackSchema>) => void,
    ) {
      const subscriptions = listeners.get(projectId) ?? new Set();
      subscriptions.add(listener);
      listeners.set(projectId, subscriptions);
      return () => {
        subscriptions.delete(listener);
        if (!subscriptions.size) listeners.delete(projectId);
      };
    },
  });
}
