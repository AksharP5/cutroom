import { z } from "zod";
import { create } from "zustand";
import {
  TimelineError,
  apply,
  applyAll,
  copyClips,
  randomClipId,
} from "../../shared/timeline/apply";
import type { ClipOrigin } from "../../shared/timeline/apply";
import {
  CommandSchema,
  ClipboardSchema,
  TimelineViewSchema,
} from "../../shared/timeline/schema";
import type {
  Clip,
  Command,
  CommandInput,
  Timeline,
  TimelineView,
} from "../../shared/timeline/schema";
import { ApiError, api, json } from "../api";
import { clipName, trackRows } from "../timeline/math";
import { emptySelection } from "../timeline/selection";
import type { Selection } from "../timeline/selection";
import { reportEditorError, showToast, useWorkspace } from "../workspace";
import { formatTimecode } from "../../shared/timeline/timecode";
import { anchorsChanged, editAnchors } from "./anchors";
import {
  outsideChanges,
  outsideMessage,
  overwriteFeedback,
  rippleFeedback,
} from "./feedback";
import { editLabel } from "../../shared/timeline/labels";
import { ReviewItemSchema } from "../../shared/review";
import { noteNumbers } from "../review";
import { dispatchNote, queueNoteChange } from "./noteStore";

const clipboards = new Map<string, readonly Clip[]>();
const clipboardIds = new Map<string, string>();
let clipboardTask = Promise.resolve();

const HistorySchema = z.object({
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  entries: z.array(z.object({ id: z.string(), undone: z.boolean() })),
});

/** The engine's timeline for the open composition, shared by the viewer, transport, and timeline. */
export const useTimeline = create(() => ({
  /** The project the views belong to; a read for another project is dropped. */
  projectId: null as string | null,
  /** The engine's last answer with the edits it has not answered yet applied on top. */
  view: null as TimelineView | null,
  history: { canUndo: false, canRedo: false },
  /** Selected clip ids. A clip id names one clip for good, so an id is that clip or gone. */
  selection: emptySelection as Selection,
  /** Dragged edges snap to clip edges, the playhead, markers, and in and out. Session state. */
  snapping: true,
}));

/** An edit as the user made it: commands built once, from the view they saw. */
interface Edit {
  projectId: string;
  label: string;
  /** Sent as they are, with every new piece named, so the server makes exactly what was shown. */
  commands: Command[];
  /** Clip ids the commands name. */
  uses: ReadonlySet<string>;
  /** Ids of the pieces the commands make. */
  creates: ReadonlySet<string>;
  /**
   * Changed clips and overwrite destination occupancy as shown, including empty ranges.
   * An edit only means the same thing while both remain unchanged.
   */
  anchors: ReturnType<typeof editAnchors>;
  gesture: boolean;
  failure: string | null;
  /** Set when an edit that made a clip this one names was refused; it is taken back with that one. */
  dropped: boolean;
}

const project = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}`;

let queue = Promise.resolve();
/** The engine's last answer, which the shown view starts from. */
let confirmed: { projectId: string; view: TimelineView } | null = null;
/** Edits shown already and not yet answered, oldest first. */
let pending: Edit[] = [];
/** The header toast this queue last showed, cleared by the next edit that lands. */
let lastToast = "";
let dismissRipple = () => {};
let dismissOutside = () => {};
let rippleRevision: string | null = null;
let historyHead: string | undefined;
let rippleHistory: string | undefined;
let outsideTimer: ReturnType<typeof setTimeout> | undefined;
let outsideStarted = 0;
let outsideClips = new Map<string, string>();
let outsideActors = new Set<string>();

function clearOutsideNotice() {
  clearTimeout(outsideTimer);
  outsideStarted = 0;
  outsideClips = new Map();
  outsideActors = new Set();
}

function noticeOutside(before: TimelineView, after: TimelineView) {
  const change = outsideChanges(before, after);
  if (!change.timelineChanged) return;
  if (!outsideStarted) outsideStarted = Date.now();
  for (const [id, kind] of change.changes) outsideClips.set(id, kind);
  outsideActors.add(change.actor);
  clearTimeout(outsideTimer);
  // Wait for 700 ms of quiet, but report a continuous stream at least every two seconds.
  outsideTimer = setTimeout(
    () => {
      dismissOutside = showToast(
        outsideMessage(outsideClips, outsideActors),
        null,
        { tone: "info", transient: true, priority: "background" },
      );
      clearOutsideNotice();
    },
    Math.max(0, Math.min(700, 2000 - (Date.now() - outsideStarted))),
  );
}

/** Opens a project's timeline, dropping what was shown for the last one. */
export function openTimeline(projectId: string, signal?: AbortSignal) {
  confirmed = null;
  pending = [];
  clearOutsideNotice();
  dismissRipple();
  dismissOutside();
  rippleRevision = null;
  useTimeline.setState({ projectId, view: null, selection: emptySelection });
  signal?.addEventListener(
    "abort",
    () => {
      clearOutsideNotice();
      dismissRipple();
      dismissOutside();
      useTimeline.setState({
        projectId: null,
        view: null,
        selection: emptySelection,
      });
    },
    { once: true },
  );
}

/**
 * Reads, edits, undo, and redo run one at a time. Each step starts from the view the previous one
 * left, so quick key presses never send a stale revision and a slow read never lands over a
 * newer view.
 */
function enqueue<T>(step: () => Promise<T>) {
  const run = queue.then(step);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Starts an export in queue order, only after the edits shown before it have landed. */
export function afterTimelineEdits<T>(
  projectId: string,
  start: () => Promise<T>,
) {
  const edits = pending.filter((edit) => edit.projectId === projectId);
  return enqueue(async () => {
    if (useTimeline.getState().projectId !== projectId)
      throw new Error("The open project changed. Export it again.");
    for (const edit of edits) if (edit.failure) throw new Error(edit.failure);
    return start();
  });
}

/**
 * Applies commands to the view the user sees, naming every piece they cut with an id no clip has
 * had, in the commands' own `ids` lists. Commands apply one at a time, so each is named by itself.
 */
function name(commands: Command[], timeline: Timeline) {
  let current = timeline;
  const creates = new Set<string>();
  const origins = new Map<string, ClipOrigin>();
  const named = commands.map((command): Command => {
    // Positional edits can cut new pieces, including moves that overwrite a spanning clip.
    if (
      command.type !== "paste" &&
      command.type !== "split" &&
      command.type !== "insert" &&
      command.type !== "trim" &&
      command.type !== "remove" &&
      command.type !== "move"
    ) {
      current = apply(current, command);
      return command;
    }
    const ids: Record<string, string[]> = { ...command.ids };
    let clipId = command.type === "insert" ? command.clip.id : undefined;
    let audioId =
      command.type === "insert" ? command.linkedAudio?.id : undefined;
    current = apply(current, command, {
      clipboards,
      onCreate: (id, origin) => {
        creates.add(id);
        origins.set(id, origin);
        if (command.type !== "insert" || !("insert" in origin)) return;
        if (origin.insert.kind === command.clip.kind) clipId = id;
        else audioId = id;
      },
      newId: (base, from, taken) => {
        const id = randomClipId(base, from, taken);
        creates.add(id);
        if (from !== null) ids[from] = [...(ids[from] ?? []), id];
        return id;
      },
    });
    return command.type === "insert"
      ? {
          ...command,
          ids,
          clip: { ...command.clip, id: clipId },
          ...(audioId !== undefined && {
            linkedAudio: { ...command.linkedAudio, id: audioId },
          }),
        }
      : { ...command, ids };
  });
  return { commands: named, creates, origins, timeline: current };
}

/**
 * The engine's last answer with each pending edit applied again on top. An edit that no longer
 * applies is left out here; its own request reports why.
 */
function shown(projectId: string): TimelineView | null {
  if (confirmed?.projectId !== projectId) return null;
  const { view } = confirmed;
  const timeline = pending
    .filter((edit) => edit.projectId === projectId)
    .reduce((current, edit) => {
      if (anchorsChanged(edit.anchors, current)) return current;
      try {
        return applyAll(current, edit.commands, { clipboards });
      } catch (error) {
        if (error instanceof TimelineError) return current;
        throw error;
      }
    }, view.timeline);
  return timeline === view.timeline ? view : { ...view, timeline };
}

async function read(projectId: string, signal?: AbortSignal, notify = true) {
  const [view, history] = await Promise.all([
    api(`${project(projectId)}/timeline`, TimelineViewSchema, { signal }),
    api(`${project(projectId)}/history`, HistorySchema, { signal }),
  ]);
  if (useTimeline.getState().projectId !== projectId) return view;
  if (
    confirmed?.projectId === projectId &&
    confirmed.view.revision !== view.revision &&
    notify
  )
    noticeOutside(confirmed.view, view);
  historyHead = history.entries.findLast((entry) => !entry.undone)?.id;
  if (
    rippleRevision &&
    (rippleRevision !== view.revision || rippleHistory !== historyHead)
  ) {
    dismissRipple();
    rippleRevision = null;
  }
  confirmed = { projectId, view };
  useTimeline.setState({ view: shown(projectId), history });
  // The engine read this timeline, so an earlier refusal no longer stands.
  reportEditorError("timeline", null);
  return view;
}

export const loadTimeline = (projectId: string, signal: AbortSignal) =>
  enqueue(async () => {
    signal.throwIfAborted();
    await read(projectId, signal);
  });

/**
 * Sends an edit's commands as they were made. When someone else edited first the revision is
 * stale, so the server is read and the same commands are sent again; they still apply when the
 * other edit left their clips alone, as with a marker after an agent's marker.
 */
async function send(edit: Edit) {
  const changed = new Error(
    `An agent changed those clips first.${edit.gesture ? "" : " Press it again."}`,
  );
  for (const retry of [false, true]) {
    const base =
      !retry && confirmed?.projectId === edit.projectId
        ? confirmed.view
        : await read(edit.projectId);
    // A cut at absolute frames only means the same cut while the clips it names are where the
    // user saw them; an agent may have moved them since, whether or not the revision is stale.
    if (anchorsChanged(edit.anchors, base.timeline)) throw changed;
    try {
      const result = await api(
        `${project(edit.projectId)}/commands`,
        TimelineViewSchema,
        json("POST", {
          composition: base.composition,
          expectedRevision: base.revision,
          label: edit.label,
          commands: edit.commands,
        }),
      );
      if (useTimeline.getState().projectId === edit.projectId)
        confirmed = { projectId: edit.projectId, view: result };
      return result;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.status === 409 && !retry) continue;
      if (error.status === 409)
        throw new Error("An agent edited first. Press it again.");
      // After someone else's edit, the engine refusing commands that applied to the view the
      // user saw means the clips changed. Checks only the server makes, such as exact readback,
      // keep their own reason.
      if (retry && error.status === 422 && error.code !== "unsupported")
        throw changed;
      throw error;
    }
  }
}

/**
 * When an edit is refused, the pieces it would have made never exist. Queued edits that name
 * them, and edits that name those edits' pieces, are taken back with it, and the pieces leave the
 * selection. The editor chose those ids, so the set is exact.
 */
function dropDependents(refused: Edit) {
  const gone = new Set(refused.creates);
  for (const edit of pending) {
    if (edit === refused || ![...edit.uses].some((id) => gone.has(id)))
      continue;
    edit.dropped = true;
    for (const id of edit.creates) gone.add(id);
  }
  pending = pending.filter((edit) => edit !== refused && !edit.dropped);
  const { selection } = useTimeline.getState();
  if (![...selection.ids].some((id) => gone.has(id))) return;
  const ids = new Set([...selection.ids].filter((id) => !gone.has(id)));
  useTimeline.setState({
    selection: {
      ids,
      anchor:
        selection.anchor && ids.has(selection.anchor) ? selection.anchor : null,
    },
  });
}

const noSizes = { video: 0, audio: 0, seam: 0, divider: 0 };
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The engine's reason in the editor's terms: tracks as V1 and A1, frames as timecode, and clips by
 * the names the timeline shows. MCP clients keep the engine's own text.
 */
function humanReason(message: string, timeline: Timeline) {
  const text = message.replace(/^Command \d+ \(\w+\): /, "");
  const rows = trackRows(timeline.tracks, noSizes).rows;
  const tracksByName = new Map<string, Set<number>>();
  for (const clip of timeline.clips) {
    const name = clipName(clip);
    const tracks = tracksByName.get(name) ?? new Set<number>();
    tracks.add(clip.track);
    tracksByName.set(name, tracks);
  }
  const names = new Map(
    timeline.clips.map((clip) => {
      const name = clipName(clip);
      const row = rows.find((row) => row.track.index === clip.track);
      return [
        clip.id,
        tracksByName.get(name)!.size > 1 && row ? `${name} on ${row.id}` : name,
      ] as const;
    }),
  );
  const ids = [...names.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(?<![\\w.-])(?:${ids.map(escaped).join("|")})(?![\\w-]|\\.[\\w.-])`,
    "g",
  );
  // Quoted text is a file name as written: shown without its quotes, never searched for ids.
  const withNames = text
    .split(/("[^"]*")/)
    .map((part) =>
      part.startsWith('"')
        ? part.slice(1, -1)
        : ids.length
          ? part.replace(pattern, (id) => names.get(id) ?? id)
          : part,
    )
    .join("");
  return withNames
    .replace(
      /\btrack (\d+)\b/gi,
      (whole, index: string) =>
        rows.find((row) => row.track.index === Number(index))?.id ?? whole,
    )
    .replace(/\bframe (\d+)\b/g, (_, frame: string) =>
      formatTimecode(Number(frame), timeline.fps),
    );
}

/**
 * Makes one undo step from the commands `build` returns for the timeline the user sees. They are
 * built once, here: a key acts on what was on screen when it was pressed, never on what a
 * rebuild against newer server state would pick. The shared engine shows the result at once and
 * the server's answer then replaces it. A refusal, here or from the server, takes the edit back
 * and says why in the header.
 */
export async function editTimeline(
  projectId: string,
  label: string,
  build: (timeline: Timeline) => CommandInput[],
  /** A mouse gesture keeps the timeline it was pressed on, even across server answers. */
  basis?: Timeline,
  /** Runs with the accepted optimistic edit, before another key can act on it. */
  onApply?: (
    timeline: Timeline,
    commands: readonly Command[],
    origins: ReadonlyMap<string, ClipOrigin>,
  ) => void,
) {
  const { view, projectId: open } = useTimeline.getState();
  if (!view || open !== projectId) return false;
  let edit: Edit | null = null;
  let accepted = false;
  try {
    const from = basis ?? view.timeline;
    const input = z.array(CommandSchema).parse(build(from));
    if (!input.length) return false;
    const named = name(input, from);
    const { commands, creates } = named;
    const anchors = editAnchors(from, named.timeline, commands);
    if (anchorsChanged(anchors, view.timeline))
      throw new Error("An agent changed those clips first.");
    const timeline =
      from === view.timeline
        ? named.timeline
        : applyAll(view.timeline, commands, { clipboards });
    edit = {
      projectId,
      label: editLabel(commands, from, label),
      commands,
      uses: new Set(
        commands.flatMap((command) =>
          "clipIds" in command
            ? (command.clipIds ?? [])
            : "clipId" in command
              ? [command.clipId]
              : [],
        ),
      ),
      creates,
      anchors,
      gesture: basis !== undefined,
      failure: null,
      dropped: false,
    };
    const made = edit;
    dismissRipple();
    rippleRevision = null;
    const feedback =
      overwriteFeedback(view.timeline, timeline, commands) ||
      rippleFeedback(view.timeline, timeline, commands, clipboards);
    useTimeline.setState({ view: { ...view, timeline } });
    pending.push(made);
    onApply?.(timeline, commands, named.origins);
    let report = "";
    let revision: string | undefined;
    let historyId: string | undefined;
    await enqueue(async () => {
      // An edit that made a clip this one names was refused, and both were taken back.
      if (made.dropped) return;
      try {
        const result = await send(made);
        revision = result?.revision;
        historyId = result?.clipEdits
          ?.filter((edit) => edit.label === made.label)
          .at(-1)?.historyId;
        if (result?.skippedClips?.length) {
          const current = new Map(
            result.timeline.clips.map((clip) => [clip.id, clip]),
          );
          const count = from.clips.filter((clip) => {
            const next = current.get(clip.id);
            return (
              !next ||
              clip.start !== next.start ||
              clip.duration !== next.duration
            );
          }).length;
          const verb = commands.every((command) => command.type === "split")
            ? "Cut"
            : "Edited";
          const names = result.skippedClips.map(
            (clip) =>
              clip.label ??
              clipName(from.clips.find((item) => item.id === clip.clipId)!),
          );
          report = `${count ? `${verb} ${count} clip${count === 1 ? "" : "s"}. ` : ""}${names.join(", ")} left whole.`;
        }
        accepted = true;
      } catch (error) {
        made.failure = humanReason(
          error instanceof Error ? error.message : String(error),
          from,
        );
        // Before the next edit runs, the queue forgets this one and the edits that named its
        // pieces, and reads what the server holds.
        dropDependents(made);
        await read(projectId).catch((failure: unknown) =>
          reportEditorError("timeline", failure),
        );
        throw error;
      }
      pending = pending.filter((item) => item !== made);
      await read(projectId);
    });
    if (!made.dropped && useTimeline.getState().projectId === projectId) {
      if (report) {
        lastToast = report;
        showToast(report, null, { tone: "info" });
      } else if (
        feedback &&
        revision === confirmed?.view.revision &&
        !pending.length &&
        historyId === historyHead
      ) {
        rippleRevision = revision ?? null;
        rippleHistory = historyId;
        dismissRipple = showToast(
          feedback,
          {
            label: "Undo",
            run: () => {
              dismissRipple();
              if (
                confirmed?.view.revision !== revision ||
                historyHead !== historyId ||
                pending.length
              )
                return;
              void stepHistory(projectId, "undo", historyId).catch(
                (error: unknown) =>
                  showToast(
                    error instanceof Error ? error.message : String(error),
                  ),
              );
            },
          },
          { tone: "info", transient: true },
        );
      } else if (lastToast && useWorkspace.getState().toast === lastToast) {
        showToast("");
      }
    }
    return accepted;
  } catch (error) {
    if (edit) pending = pending.filter((item) => item !== edit);
    if (useTimeline.getState().projectId !== projectId) return false;
    const shownView = shown(projectId);
    if (shownView) useTimeline.setState({ view: shownView });
    lastToast = humanReason(
      error instanceof Error ? error.message : String(error),
      view.timeline,
    );
    showToast(lastToast);
    return accepted;
  }
}

export const stepHistory = (
  projectId: string,
  step: "undo" | "redo",
  expectedHistoryId?: string,
) =>
  queueNoteChange(projectId, () =>
    clipboardTask.then(() =>
      enqueue(async () => {
        if (expectedHistoryId) {
          await read(projectId);
          if (historyHead !== expectedHistoryId)
            throw new Error("The history changed. Use Undo in the toolbar.");
        }
        dismissRipple();
        rippleRevision = null;
        // React's notebook may still predate the save, even while its pin is visible.
        const before =
          step === "undo"
            ? await api(
                `${project(projectId)}/review`,
                z.object({ items: z.array(ReviewItemSchema) }),
              ).catch((error: unknown) => {
                // Undo can repair unreadable note metadata; its own route still validates history.
                if (error instanceof ApiError && error.status === 422)
                  return null;
                throw error;
              })
            : null;
        await api(
          `${project(projectId)}/history/${step}`,
          z.unknown(),
          json("POST"),
        );
        await read(projectId, undefined, false);
        if (!before?.items.length) return;
        const after = await api(
          `${project(projectId)}/review`,
          z.object({ items: z.array(ReviewItemSchema) }),
        );
        const removed = before.items.filter(
          (note) => !after.items.some((item) => item.id === note.id),
        );
        const first = removed[0];
        if (!first) return;
        // A note undone before its first notebook refresh must also leave the optimistic layer.
        dispatchNote(projectId, {
          type: "landed",
          ids: new Set(removed.map((note) => note.id)),
        });
        if (useTimeline.getState().projectId === projectId)
          showToast(
            `Note ${noteNumbers(before.items).get(first.id)} removed ·`,
            {
              label: "Redo",
              run: () => {
                showToast("");
                void stepHistory(projectId, "redo").catch((error: unknown) =>
                  reportEditorError("timeline", error),
                );
              },
            },
          );
      }),
    ),
  );

/** Whether clips have been copied in this project, so a paste has something to place. */
export const hasClipboard = (projectId: string) => clipboardIds.has(projectId);

/** Clipboard keys serialize copy/cut/paste, including a paste pressed before copy has answered. */
export function clipboardEdit(
  projectId: string,
  action: "copy" | "cut" | "overwrite" | "insert",
  at: number,
) {
  const { selection, view } = useTimeline.getState();
  const clipIds = [...selection.ids];
  const seen = view?.timeline;
  clipboardTask = clipboardTask
    .then(async () => {
      if (action === "copy" || action === "cut") {
        if (!clipIds.length || !seen) return;
        const targets = copyClips(seen, clipIds);
        const copied = await enqueue(async () => {
          const view = await read(projectId);
          if (
            anchorsChanged({ clips: targets, destinations: [] }, view.timeline)
          )
            throw new Error(
              "An agent changed those clips first. Copy them again.",
            );
          return api(
            `${project(projectId)}/timeline/copy`,
            ClipboardSchema,
            json("POST", {
              composition: view.composition,
              expectedRevision: view.revision,
              clipIds,
            }),
          );
        });
        clipboards.set(copied.id, copied.clips);
        clipboardIds.set(projectId, copied.id);
        if (action === "cut")
          await editTimeline(
            projectId,
            "Cut clips",
            () => [{ type: "remove", clipIds, ripple: false }],
            seen,
          );
        return;
      }
      const clipboardId = clipboardIds.get(projectId);
      if (!clipboardId) {
        showToast("Copy clips before pasting.");
        return;
      }
      await editTimeline(
        projectId,
        "Pasted clips",
        () => [{ type: "paste", clipboardId, at, mode: action }],
        undefined,
        (_timeline, _commands, origins) => {
          // Destination heads and tails are new pieces too; select only the clipboard copies.
          const ids = new Set(
            [...origins].flatMap(([id, origin]) =>
              "clipboardId" in origin ? [id] : [],
            ),
          );
          useTimeline.setState({
            selection: { ids, anchor: [...ids][0] ?? null },
          });
        },
      );
    })
    .catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : String(error));
    });
}
