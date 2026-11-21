import { sameRate } from "../../shared/projectFormat";
import { z } from "zod";
import { create } from "zustand";
import {
  TimelineError,
  apply,
  applyAll,
  canonicalTimeline,
  copyClips,
  randomClipId,
} from "../../shared/timeline/apply";
import type { ClipOrigin } from "../../shared/timeline/apply";
import {
  AnimationFeedbackSchema,
  EDIT_HISTORY_HEADER,
  GROUPED_EDIT_HEADER,
  TAB_ORIGIN_HEADER,
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
import { ApiError, api, json, tabOrigin } from "../api";
import { clipName, trackRows } from "../timeline/math";
import { emptySelection } from "../timeline/selection";
import type { Selection } from "../timeline/selection";
import { reportEditorError, showToast, useWorkspace } from "../workspace";
import { formatTimecode } from "../../shared/timeline/timecode";
import { pasteAttributes } from "./pasteAttributes";
import { anchorsChanged, editAnchors } from "./anchors";
import {
  outsideChanges,
  outsideMessage,
  overwriteFeedback,
  rippleFeedback,
} from "./feedback";
import { editLabel } from "../../shared/timeline/labels";
import { isMediaItem, inMediaTrash } from "../../shared/media";
import { ReviewItemSchema } from "../../shared/review";
import {
  dismissAnimationFeedback,
  showAnimationFeedback,
} from "./animationFeedback";
import { noteNumbers } from "../review";
import {
  dispatchNote,
  hasQueuedNoteChange,
  queueNoteChange,
  unobservedNoteHistory,
} from "./noteStore";
import { sameHeldKey } from "../keymap";
import type { HeldKey } from "../keymap";

/** The project's entry composition, which the editor opens first. */
export const ROOT_COMPOSITION = "index.html";

const clipboards = new Map<string, readonly Clip[]>();
const clipboardIds = new Map<string, string>();
const clipboardSources = new Map<
  string,
  { id: string; fps: Timeline["fps"] }
>();
let clipboardTask = Promise.resolve();

const HistoryTargetSchema = z.object({ id: z.string(), label: z.string() });
const HistorySchema = z.object({
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  nextUndo: HistoryTargetSchema.nullable(),
  nextRedo: HistoryTargetSchema.nullable(),
  entries: z.array(
    z.object({
      id: z.string(),
      undone: z.boolean(),
      undoes: z.string().optional(),
    }),
  ),
});
const emptyHistory: z.infer<typeof HistorySchema> = {
  canUndo: false,
  canRedo: false,
  nextUndo: null,
  nextRedo: null,
  entries: [],
};
const pendingEditHistory = { ...emptyHistory, canUndo: true };
let confirmedHistory = emptyHistory;
let unobservedTimelineHistory:
  { projectId: string; entryId: string } | undefined;
const historyControls = (projectId: string) =>
  pending.some((edit) => edit.projectId === projectId)
    ? pendingEditHistory
    : confirmedHistory;
const TimelineEditsSchema = TimelineViewSchema.pick({ clipEdits: true });
const HistoryReplaySchema = z.object({
  entry: z
    .object({
      id: z.string(),
      label: z.string(),
      files: z.array(
        z.object({
          path: z.string(),
          before: z.string().nullable(),
          after: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  view: TimelineViewSchema.nullish(),
  history: HistorySchema.optional(),
  message: z.string().optional(),
  skipped: z.object({ id: z.string(), label: z.string() }).optional(),
  kept: z
    .object({ count: z.number(), authors: z.array(z.string()) })
    .optional(),
  removedNotes: z.array(z.string()).optional(),
  notesBefore: z.array(ReviewItemSchema).optional(),
});
const UndoTogetherSchema = z.object({
  entryId: z.string(),
  withEntries: z.array(z.string()),
});
const HistoryConflictSchema = z.object({
  conflict: z.object({
    undoTogether: UndoTogetherSchema.optional(),
    skipEntryId: z.string().optional(),
    blocking: z
      .array(z.object({ author: z.object({ name: z.string() }) }))
      .optional(),
  }),
});
const historyPictures = new Map<
  string,
  { from: TimelineView; to: TimelineView }
>();

function rememberHistoryPicture(
  id: string,
  from: TimelineView,
  to: TimelineView,
) {
  historyPictures.set(id, { from, to });
  if (historyPictures.size > 50)
    historyPictures.delete(historyPictures.keys().next().value!);
}

function showHistoryChanges() {
  useTimeline.setState({ selection: emptySelection });
  useWorkspace.setState({ inspector: true });
}

/** The engine's timeline for the open composition, shared by the viewer, transport, and timeline. */
export const useTimeline = create(() => ({
  /** The project the views belong to; a read for another project is dropped. */
  projectId: null as string | null,
  /** The composition being edited; a read of another composition is dropped. */
  composition: ROOT_COMPOSITION,
  /** The compositions it was opened from, the root first. */
  parents: [] as readonly string[],
  /** The engine's last answer with the edits it has not answered yet applied on top. */
  view: null as TimelineView | null,
  /** Review can still show pending edits when authored source cannot produce a timeline. */
  failedRead: null as ApiError | null,
  history: emptyHistory,
  /** Selected clip ids. A clip id names one clip for good, so an id is that clip or gone. */
  selection: emptySelection as Selection,
  /** Dragged edges snap to clip edges, the playhead, markers, and in and out. Session state. */
  snapping: true,
  /** Whether selection expands to a clip’s linked partners. Session state. */
  linkedSelection: true,
  /** What the Trim tool's comma and period do, switched with S as in Resolve. Session state. */
  trimKeys: "slip" as "slip" | "slide",
}));

/** An edit as the user made it: commands built once, from the view they saw. */
interface Edit {
  projectId: string;
  composition: string;
  label: string;
  /** Sent as they are, with every new piece named, so the server makes exactly what was shown. */
  commands: Command[];
  fps: Timeline["fps"];
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
  held?: boolean;
  grouped?: boolean;
  failure: string | null;
  /** Resolves when this save has left the queue, including when it was refused. */
  saved: Promise<void>;
  /** Set when an edit that made a clip this one names was refused; it is taken back with that one. */
  dropped: boolean;
}

const project = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}`;

let queue = Promise.resolve();
let compositionRequest = 0;
/** The engine's last answer for the open composition, which the shown view starts from. */
let confirmed: { projectId: string; view: TimelineView } | null = null;
/** Each composition's last answer in the open project, so returning to one shows it at once. */
const answers = new Map<string, TimelineView>();
/** Edits shown already and not yet answered, oldest first. */
let pending: Edit[] = [];
const pendingHistory = new Map<string, Set<Promise<void>>>();

type RepeatedCommand = Extract<
  Command,
  { type: "move" | "roll" | "slide" | "slip" | "trim" }
>;

type OnEditApplied = (
  timeline: Timeline,
  commands: readonly Command[],
  origins: ReadonlyMap<string, ClipOrigin>,
) => void;

/** A held key can edit the same targets repeatedly before saving on release. */
interface HeldEdit {
  edit: Edit;
  physicalKey: HeldKey;
  key: string;
  before: Timeline;
  after: Timeline;
  combined: RepeatedCommand[];
  onApply: OnEditApplied | undefined;
  updateFeedback: (
    commands: readonly Command[],
    before: Timeline,
    after: Timeline,
  ) => void;
  invalidated: boolean;
  start: () => void;
  result: Promise<boolean>;
}

let heldEdit: HeldEdit | null = null;

export function hasPendingTimelineSaves() {
  return pending.length > 0 || pendingHistory.size > 0;
}

export function finishHeldEdit(physicalKey?: HeldKey) {
  const hold = heldEdit;
  if (!hold || (physicalKey && !sameHeldKey(hold.physicalKey, physicalKey)))
    return;
  heldEdit = null;
  try {
    const { before, after, edit, combined } = hold;
    if (edit.commands.length === combined.length) return;
    edit.grouped = true;
    edit.label = editLabel(combined, before, edit.label);
    edit.anchors = editAnchors(before, after, edit.commands);
    hold.updateFeedback(combined, before, after);

    let created = false;
    const projected = applyAll(before, combined, {
      clipboards,
      composition: edit.composition,
      onCreate: () => {
        created = true;
      },
    });
    // An overwrite or source boundary can give merged commands a different result.
    if (
      !created &&
      JSON.stringify(canonicalTimeline(projected)) ===
        JSON.stringify(canonicalTimeline(after))
    )
      edit.commands = combined;
  } catch (error) {
    if (!(error instanceof TimelineError)) throw error;
    // The queued steps were admitted separately. Keep them when their sum is refused.
  } finally {
    hold.start();
  }
}

function repeatedEdit(physicalKey: string, commands: Command[]) {
  const eligible = (command: Command): command is RepeatedCommand =>
    command.type === "move" ||
    command.type === "roll" ||
    command.type === "slide" ||
    command.type === "slip" ||
    command.type === "trim";
  if (!commands.every(eligible)) return;
  const targets = commands.map((command) => {
    if (command.type === "trim") {
      const { to, ...target } = command;
      return target;
    }
    const { by, ...target } = command;
    return target;
  });
  return { key: JSON.stringify([physicalKey, targets]), commands };
}

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
let outsideTarget: string | null | undefined;

function clearOutsideNotice() {
  clearTimeout(outsideTimer);
  outsideStarted = 0;
  outsideClips = new Map();
  outsideActors = new Set();
  outsideTarget = undefined;
}

const heldEditRefusal = "An agent changed those clips first.";

function invalidateHeldEdit(hold: HeldEdit | null) {
  if (!hold) return;
  hold.invalidated = true;
  lastToast = heldEditRefusal;
  showToast(lastToast);
}

function noticeOutside(
  projectId: string,
  before: TimelineView,
  after: TimelineView,
) {
  const change = outsideChanges(before, after);
  if (!change.timelineChanged) return;
  if (!outsideStarted) outsideStarted = Date.now();
  for (const [id, kind] of change.changes) outsideClips.set(id, kind);
  outsideActors.add(change.actor);
  const added = new Set(
    after.clipEdits
      ?.filter(({ by }) => by === "agent")
      .map(({ historyId }) => historyId),
  );
  const [id] = added;
  outsideTarget =
    added.size === 1 &&
    id &&
    (outsideTarget === undefined || outsideTarget === id)
      ? id
      : null;
  clearTimeout(outsideTimer);
  // Wait for 700 ms of quiet, but report a continuous stream at least every two seconds.
  outsideTimer = setTimeout(
    () => {
      const id = outsideTarget;
      dismissOutside = showToast(
        outsideMessage(outsideClips, outsideActors),
        id
          ? {
              label: `Undo ${[...outsideActors][0] ?? "agent"}'s edit`,
              run: () => {
                dismissOutside();
                void stepHistory(projectId, "undo", id).catch(
                  (error: unknown) => reportEditorError("timeline", error),
                );
              },
            }
          : null,
        { tone: "info", transient: true, priority: "background" },
      );
      clearOutsideNotice();
    },
    Math.max(0, Math.min(700, 2000 - (Date.now() - outsideStarted))),
  );
}

/** Opens a project's timeline, dropping what was shown for the last one. */
export function openTimeline(projectId: string, signal?: AbortSignal) {
  compositionRequest++;
  dismissAnimationFeedback();
  confirmed = null;
  answers.clear();
  historyPictures.clear();
  pending = [];
  clearOutsideNotice();
  dismissRipple();
  dismissOutside();
  rippleRevision = null;
  historyHead = undefined;
  confirmedHistory = emptyHistory;
  unobservedTimelineHistory = undefined;
  useTimeline.setState({
    projectId,
    composition: ROOT_COMPOSITION,
    parents: [],
    view: null,
    failedRead: null,
    history: emptyHistory,
    selection: emptySelection,
  });
  signal?.addEventListener(
    "abort",
    () => {
      dismissAnimationFeedback();
      clearOutsideNotice();
      dismissRipple();
      dismissOutside();
      useTimeline.setState({
        projectId: null,
        view: null,
        failedRead: null,
        history: emptyHistory,
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
  finishHeldEdit();
  return serialize(step);
}

function serialize<T>(step: () => Promise<T>) {
  const run = queue.then(step);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** A preview of an intermediate save would compete with the remaining writes in a burst. */
export function afterEditBurst(projectId: string, composition: string) {
  const saves = pending.filter(
    (edit) =>
      edit !== heldEdit?.edit &&
      edit.projectId === projectId &&
      edit.composition === composition,
  );
  const history = pendingHistory.get(projectId);
  const writes: Promise<void>[] = [];
  if (saves.length > 1) writes.push(...saves.map((edit) => edit.saved));
  if (history && history.size > 1) writes.push(...history);
  return Promise.allSettled(writes);
}

/** Runs a source operation or export only after the edits shown before it have landed. */
export function afterTimelineEdits<T>(
  projectId: string,
  start: () => Promise<T>,
) {
  const edits = pending.filter((edit) => edit.projectId === projectId);
  return enqueue(async () => {
    if (useTimeline.getState().projectId !== projectId)
      throw new Error("The open project changed. Try again.");
    for (const edit of edits) if (edit.failure) throw new Error(edit.failure);
    return start();
  });
}

/** A source inspector edit shares queue order and history refresh with timeline edits and Undo. */
export function editCompositionSource<T>(
  projectId: string,
  composition: string,
  edit: () => Promise<T>,
) {
  return afterTimelineEdits(projectId, async () => {
    if (!isOpen(projectId, composition))
      throw new Error("The open composition changed. Inspect motion again.");
    const result = await edit();
    await read(projectId, undefined, false, composition);
    return result;
  });
}

/**
 * Applies commands to the view the user sees, naming every piece they cut with an id no clip has
 * had, in the commands' own `ids` lists. Commands apply one at a time, so each is named by itself.
 */
function name(commands: Command[], timeline: Timeline, composition: string) {
  let current = timeline;
  const creates = new Set<string>();
  const origins = new Map<string, ClipOrigin>();
  const named = commands.map((command): Command => {
    // Positional edits can cut new pieces, including moves that overwrite a spanning clip.
    if (
      command.type !== "paste" &&
      command.type !== "freeze" &&
      command.type !== "split" &&
      command.type !== "insert" &&
      command.type !== "trim" &&
      command.type !== "trimPlayhead" &&
      command.type !== "remove" &&
      command.type !== "move"
    ) {
      current = apply(current, command);
      return command;
    }
    const ids: Record<string, string[]> = { ...command.ids };
    let stillId = command.type === "freeze" ? command.id : undefined;
    let clipId = command.type === "insert" ? command.clip.id : undefined;
    let audioId =
      command.type === "insert" ? command.linkedAudio?.id : undefined;
    current = apply(current, command, {
      composition,
      clipboards,
      onCreate: (id, origin) => {
        creates.add(id);
        origins.set(id, origin);
        if (command.type === "freeze" && "freeze" in origin) stillId = id;
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
      : command.type === "freeze"
        ? { ...command, id: stillId, ids }
        : { ...command, ids };
  });
  return { commands: named, creates, origins, timeline: current };
}

function createsAudioGroup(commands: readonly Command[]) {
  return commands.some(
    (command) =>
      command.type === "routeAudioGroup" &&
      command.group !== null &&
      typeof command.group !== "string",
  );
}

/**
 * Reapply pending edits that still fit the server's last answer. A new audio group
 * appears once the server returns its ID, so another edit can safely name it.
 */
function shown(projectId: string): TimelineView | null {
  if (confirmed?.projectId !== projectId) return null;
  const { view } = confirmed;
  const timeline = pending
    .filter(
      (edit) =>
        edit.projectId === projectId && edit.composition === view.composition,
    )
    .reduce((current, edit) => {
      const hold = heldEdit?.edit === edit ? heldEdit : null;
      if (hold?.invalidated) return current;
      if (hold?.before === current) return hold.after;
      if (hold)
        edit.anchors = editAnchors(hold.before, hold.after, edit.commands);
      if (
        createsAudioGroup(edit.commands) ||
        !sameRate(edit.fps, current.fps) ||
        anchorsChanged(edit.anchors, current)
      ) {
        invalidateHeldEdit(hold);
        return current;
      }
      try {
        const next = applyAll(current, edit.commands, {
          clipboards,
          composition: edit.composition,
        });
        if (hold) {
          hold.before = current;
          hold.after = next;
        }
        return next;
      } catch (error) {
        if (error instanceof TimelineError) {
          invalidateHeldEdit(hold);
          return current;
        }
        throw error;
      }
    }, view.timeline);
  return timeline === view.timeline ? view : { ...view, timeline };
}

/** Whether the editor shows this project and composition, so an answer for them may be shown. */
function isOpen(projectId: string, composition: string) {
  const state = useTimeline.getState();
  return state.projectId === projectId && state.composition === composition;
}

const readHistory = (projectId: string, signal?: AbortSignal) =>
  api(`${project(projectId)}/history`, HistorySchema, { signal });

/** Shows the engine's last answer, `confirmed`, with the undo history that came with it. */
function settle(
  projectId: string,
  view: TimelineView,
  history: z.infer<typeof HistorySchema>,
) {
  historyHead = history.entries.findLast((entry) => !entry.undone)?.id;
  if (
    rippleRevision &&
    (rippleRevision !== view.revision || rippleHistory !== historyHead)
  ) {
    dismissRipple();
    rippleRevision = null;
  }
  if (
    history.entries.some(
      ({ id }) => id === unobservedNoteHistory.get(projectId),
    )
  )
    unobservedNoteHistory.delete(projectId);
  if (
    unobservedTimelineHistory?.projectId === projectId &&
    history.entries.some(({ id }) => id === unobservedTimelineHistory?.entryId)
  )
    unobservedTimelineHistory = undefined;
  confirmedHistory = history;
  useTimeline.setState({
    view: shown(projectId),
    history: historyControls(projectId),
    failedRead: null,
  });
  // The engine read this timeline, so an earlier refusal no longer stands.
  reportEditorError("timeline", null);
}

async function read(
  projectId: string,
  signal?: AbortSignal,
  notify = true,
  composition = useTimeline.getState().composition,
  select?: (view: TimelineView | null) => void,
) {
  const historyRead = readHistory(projectId, signal);
  const [view, history] = await Promise.all([
    api(
      `${project(projectId)}/timeline${
        composition === ROOT_COMPOSITION
          ? ""
          : `?composition=${encodeURIComponent(composition)}`
      }`,
      TimelineViewSchema,
      { signal },
    ).catch(async (error: unknown) => {
      if (error instanceof ApiError && error.status === 422) {
        const history = await historyRead.catch(() => null);
        if (!signal?.aborted) select?.(null);
        if (!signal?.aborted && isOpen(projectId, composition)) {
          if (history) {
            historyHead = history.entries.findLast(
              (entry) => !entry.undone,
            )?.id;
            confirmedHistory = history;
          }
          useTimeline.setState({
            history: historyControls(projectId),
            failedRead: error,
          });
        }
      }
      throw error;
    }),
    historyRead,
  ]);
  if (signal?.aborted || useTimeline.getState().projectId !== projectId)
    return view;
  answers.set(view.composition, view);
  select?.(view);
  if (!isOpen(projectId, view.composition)) return view;
  if (
    confirmed?.view.composition === view.composition &&
    confirmed.view.revision !== view.revision &&
    notify
  ) {
    const head = history.entries.findIndex(({ id }) => id === historyHead);
    const newer = history.entries.slice(head + 1);
    const replayOnly =
      head >= 0 && newer.length && newer.every(({ undoes }) => undoes);
    if (!replayOnly) {
      const before = confirmed.view;
      const known = new Set(before.reviewEntries);
      const entries = view.reviewEntries?.filter((entry) => !known.has(entry));
      const details = entries?.length
        ? await api(
            `${project(projectId)}/review/changes`,
            TimelineEditsSchema,
            {
              ...json("POST", { composition, entries }),
              signal,
            },
          ).catch(() => null)
        : null;
      if (signal?.aborted || !isOpen(projectId, composition)) return view;
      noticeOutside(projectId, before, {
        ...view,
        clipEdits: details?.clipEdits,
      });
    }
  }
  confirmed = { projectId, view };
  settle(projectId, view, history);
  return view;
}

/**
 * Compositions seen before show their last projection while a read catches up. A first read can
 * open the source and picture even if there is no valid timeline for it.
 */
export function showComposition(
  projectId: string,
  composition: string,
  parents: readonly string[],
  selection: Selection,
) {
  const request = ++compositionRequest;
  const current = () =>
    request === compositionRequest &&
    useTimeline.getState().projectId === projectId;
  const show = (view: TimelineView | null) => {
    if (!current()) return;
    confirmed = view ? { projectId, view } : null;
    dismissRipple();
    rippleRevision = null;
    useTimeline.setState({
      composition,
      parents,
      selection,
      view: shown(projectId),
      failedRead: null,
    });
    if (view) reportEditorError("timeline", null);
  };
  const known = answers.get(composition);
  if (known) show(known);
  return enqueue(async () => {
    if (!current()) return;
    try {
      await read(
        projectId,
        undefined,
        false,
        composition,
        known ? undefined : show,
      );
    } catch (error) {
      if (!current()) return;
      if (!(error instanceof ApiError && error.status === 422)) throw error;
      reportEditorError("timeline", error);
    }
  });
}

/** A projection failure belongs to the composition read when the queued refresh starts. */
async function refreshOpenTimeline(
  projectId: string,
  signal?: AbortSignal,
  notify = true,
) {
  if (signal?.aborted || useTimeline.getState().projectId !== projectId) return;
  const { composition } = useTimeline.getState();
  try {
    await read(projectId, signal, notify, composition);
  } catch (error) {
    if (!signal?.aborted && isOpen(projectId, composition))
      reportEditorError("timeline", error);
  }
}

export const loadTimeline = (projectId: string, signal: AbortSignal) =>
  enqueue(() => refreshOpenTimeline(projectId, signal));

/** The first file event gives related events time to join the same read. */
const REFRESH_QUIET_MS = 100;
let refresh: { signal: AbortSignal; done: Promise<void> } | null = null;

/** Read after queued saves. Outside changes still show during an unsaved hold. */
export function refreshTimeline(projectId: string, signal: AbortSignal) {
  if (refresh?.signal === signal) return refresh.done;
  const next = {
    signal,
    done: new Promise((resolve) => setTimeout(resolve, REFRESH_QUIET_MS)).then(
      () =>
        serialize(async () => {
          if (refresh === next) refresh = null;
          await refreshOpenTimeline(projectId, signal);
        }),
    ),
  };
  refresh = next;
  return next.done;
}

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
      !retry &&
      confirmed?.projectId === edit.projectId &&
      confirmed.view.composition === edit.composition
        ? confirmed.view
        : await read(edit.projectId, undefined, true, edit.composition);
    // A cut at absolute frames only means the same cut while the clips it names are where the
    // user saw them; an agent may have moved them since, whether or not the revision is stale.
    if (!sameRate(edit.fps, base.timeline.fps))
      throw new Error("The frame rate changed. Make the edit again.");
    if (anchorsChanged(edit.anchors, base.timeline)) throw changed;
    try {
      let historyId: string | undefined;
      const request = json("POST", {
        composition: base.composition,
        expectedRevision: base.revision,
        label: edit.label,
        commands: edit.commands,
      });
      // An in-flight held edit may need to finish after the tab closes.
      if (
        edit.held &&
        typeof request.body === "string" &&
        new TextEncoder().encode(request.body).length <= 64 * 1024
      )
        request.keepalive = true;
      const result = await api(
        `${project(edit.projectId)}/commands`,
        TimelineViewSchema,
        {
          ...request,
          headers: {
            [TAB_ORIGIN_HEADER]: tabOrigin,
            ...(edit.grouped && { [GROUPED_EDIT_HEADER]: "1" }),
          },
        },
        (headers) => {
          historyId = headers.get(EDIT_HISTORY_HEADER) ?? undefined;
        },
      );
      if (useTimeline.getState().projectId === edit.projectId) {
        answers.set(result.composition, result);
        if (historyId) {
          unobservedTimelineHistory = {
            projectId: edit.projectId,
            entryId: historyId,
          };
          rememberHistoryPicture(historyId, result, base);
        }
      }
      if (isOpen(edit.projectId, result.composition))
        confirmed = { projectId: edit.projectId, view: result };
      return { ...result, historyId };
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
 * rebuild against newer server state would pick. The shared engine previews edits whose IDs are
 * already known, then the server's answer settles them. A refusal says why in the header.
 */
export async function editTimeline(
  projectId: string,
  label: string,
  build: (timeline: Timeline) => CommandInput[],
  /** A mouse gesture keeps the timeline it was pressed on, even across server answers. */
  basis?: Timeline,
  /** Runs with the accepted optimistic edit, before another key can act on it. */
  onApply?: OnEditApplied,
  onCommit?: (view: TimelineView) => void,
  heldKey?: HeldKey,
) {
  const { view, projectId: open } = useTimeline.getState();
  if (!view || open !== projectId) return false;
  if (
    heldKey &&
    heldEdit?.invalidated &&
    sameHeldKey(heldEdit.physicalKey, heldKey)
  )
    return false;
  // A success clears the refusal this edit followed, never one shown while it was saving.
  const followed = lastToast;
  let edit: Edit | null = null;
  let draft: HeldEdit | undefined;
  let accepted = false;
  const saved = Promise.withResolvers<void>();
  const outcome = heldKey ? Promise.withResolvers<boolean>() : null;
  try {
    const from = basis ?? view.timeline;
    if (!sameRate(from.fps, view.timeline.fps))
      throw new Error("The frame rate changed. Make the edit again.");
    const input = z.array(CommandSchema).parse(build(from));
    if (!input.length) return false;
    const named = name(input, from, view.composition);
    const { commands, creates } = named;
    const repetition =
      heldKey && basis === undefined && !creates.size
        ? repeatedEdit(heldKey.code || heldKey.key, commands)
        : undefined;
    const group = heldEdit;
    if (
      repetition &&
      group?.key === repetition.key &&
      group.edit.projectId === projectId &&
      group.edit.composition === view.composition &&
      group.after === from &&
      group.edit.commands.length + commands.length <= 1000
    ) {
      group.edit.commands.push(...commands);
      group.combined = repetition.commands.map((step, index) => {
        const previous = group.combined[index]!;
        return step.type === "trim" || previous.type === "trim"
          ? step
          : { ...step, by: previous.by + step.by };
      });
      group.after = named.timeline;
      useTimeline.setState({
        view: { ...view, timeline: named.timeline },
        history: pendingEditHistory,
      });
      group.onApply?.(named.timeline, commands, named.origins);
      return await group.result;
    }
    const anchors = editAnchors(from, named.timeline, commands);
    if (from !== view.timeline && anchorsChanged(anchors, view.timeline))
      throw new Error("An agent changed those clips first.");
    const timeline =
      from === view.timeline
        ? named.timeline
        : applyAll(view.timeline, commands, {
            clipboards,
            composition: view.composition,
          });
    edit = {
      projectId,
      composition: view.composition,
      label: editLabel(commands, from, label),
      commands,
      fps: from.fps,
      uses: new Set(
        commands.flatMap((command) =>
          "clipIds" in command
            ? (command.clipIds ?? [])
            : "clipId" in command && command.clipId !== undefined
              ? [command.clipId]
              : command.type === "setTransition" ||
                  command.type === "roll" ||
                  command.type === "swap"
                ? [command.from, command.to]
                : command.type === "setTransitions"
                  ? command.cuts.flatMap(({ from, to }) => [from, to])
                  : [],
        ),
      ),
      creates,
      anchors,
      gesture: basis !== undefined,
      held: repetition !== undefined,
      failure: null,
      saved: saved.promise,
      dropped: false,
    };
    const made = edit;
    dismissRipple();
    rippleRevision = null;
    let feedback = "";
    const updateFeedback = (
      commands: readonly Command[],
      before: Timeline,
      after: Timeline,
    ) => {
      feedback =
        overwriteFeedback(before, after, commands) ||
        rippleFeedback(before, after, commands, clipboards);
    };
    updateFeedback(commands, view.timeline, timeline);
    // Other edits can look up this bus as soon as it appears in the inspector.
    // Publish only the persisted ID from the server.
    pending.push(made);
    useTimeline.setState({
      ...(!createsAudioGroup(commands) && { view: { ...view, timeline } }),
      history: pendingEditHistory,
    });
    onApply?.(timeline, commands, named.origins);
    let report = "";
    let revision: string | undefined;
    let historyId: string | undefined;
    const commit = async () => {
      // An edit that made a clip this one names was refused, and both were taken back.
      if (made.dropped) return;
      try {
        if (draft?.invalidated) throw new Error(heldEditRefusal);
        const result = await send(made);
        revision = result?.revision;
        historyId = result?.historyId;
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
        await refreshOpenTimeline(projectId);
        throw error;
      }
      pending = pending.filter((item) => item !== made);
      // The next saved edit can already use this answer's revision. The visible timeline
      // has the rest of the burst applied, so only its last edit needs a history read and
      // a new projection. Read immediately if the server differed from the optimistic edit.
      const more = () =>
        pending.some(
          (item) =>
            item.projectId === projectId &&
            item.composition === made.composition,
        );
      const reconcile = report || createsAudioGroup(made.commands);
      if (more() && !reconcile) return;
      const history = await readHistory(projectId);
      if (confirmed?.projectId === projectId && (!more() || reconcile))
        settle(projectId, confirmed.view, history);
      if (
        confirmed &&
        confirmed.projectId === projectId &&
        confirmed.view.revision === revision
      )
        onCommit?.(confirmed.view);
    };
    let save: Promise<void>;
    if (heldKey && repetition && outcome) {
      finishHeldEdit();
      const write = Promise.withResolvers<void>();
      made.commands = [...commands];
      draft = heldEdit = {
        edit: made,
        physicalKey: heldKey,
        key: repetition.key,
        before: from,
        after: timeline,
        combined: repetition.commands,
        onApply,
        updateFeedback,
        invalidated: false,
        start: () => {
          void serialize(commit).then(write.resolve, write.reject);
        },
        result: outcome.promise,
      };
      save = write.promise;
    } else {
      save = enqueue(commit);
    }
    await save;
    if (!made.dropped && useTimeline.getState().projectId === projectId) {
      if (report) {
        lastToast = report;
        showToast(report, null, { tone: "info" });
      } else if (
        feedback &&
        historyId &&
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
      } else if (
        followed &&
        lastToast === followed &&
        useWorkspace.getState().toast === followed
      ) {
        showToast("");
      }
    }
    return accepted;
  } catch (error) {
    if (edit) pending = pending.filter((item) => item !== edit);
    if (useTimeline.getState().projectId !== projectId) return false;
    const shownView = shown(projectId);
    useTimeline.setState({
      ...(shownView && { view: shownView }),
      history: historyControls(projectId),
    });
    lastToast = humanReason(
      error instanceof Error ? error.message : String(error),
      view.timeline,
    );
    if (!draft?.invalidated || useWorkspace.getState().toast !== lastToast)
      showToast(lastToast);
    return accepted;
  } finally {
    saved.resolve();
    outcome?.resolve(accepted);
  }
}

export function stepHistory(
  projectId: string,
  step: "undo" | "redo",
  expectedHistoryId?: string,
  withEntries?: string[],
  skip?: true,
) {
  const nextId = (history: typeof emptyHistory) =>
    (step === "undo" ? history.nextUndo : history.nextRedo)?.id ?? null;
  // A press targets the history shown at that moment. Steps behind a local save or
  // a previous press bind to the answer from that queued operation.
  const priorStep = pendingHistory.has(projectId);
  const notePending = !priorStep && hasQueuedNoteChange(projectId);
  const editPending = pending.some((edit) => edit.projectId === projectId);
  const observed = confirmedHistory;
  const seen =
    (step === "undo"
      ? (unobservedNoteHistory.get(projectId) ??
        (unobservedTimelineHistory?.projectId === projectId
          ? unobservedTimelineHistory.entryId
          : undefined))
      : undefined) ?? nextId(observed);
  const run = queueNoteChange(projectId, () =>
    clipboardTask.then(() =>
      enqueue(async () => {
        dismissRipple();
        rippleRevision = null;
        const open = useTimeline.getState();
        const here = open.projectId === projectId;
        const queued = nextId(confirmedHistory);
        // A preceding Undo can reveal an older entry, but a new entry from another
        // tab must not become the target of a keypress already in the queue.
        const unseenUndo =
          step === "undo" &&
          priorStep &&
          !editPending &&
          queued !== null &&
          !observed.entries.some(({ id }) => id === queued);
        const target =
          expectedHistoryId ??
          (notePending
            ? ((step === "undo"
                ? unobservedNoteHistory.get(projectId)
                : undefined) ?? nextId(await readHistory(projectId)))
            : (priorStep || editPending) && !unseenUndo
              ? queued
              : seen);
        const standing = here ? confirmed?.view : undefined;
        const prediction =
          !withEntries && !skip && target && target === historyHead
            ? historyPictures.get(target)
            : undefined;
        const painted =
          standing &&
          prediction?.from.revision === standing.revision &&
          prediction.from.composition === standing.composition &&
          !pending.length
            ? {
                ...standing,
                timeline: prediction.to.timeline,
                size: prediction.to.size,
              }
            : undefined;
        if (painted) useTimeline.setState({ view: painted });

        let replay: z.output<typeof HistoryReplaySchema>;
        try {
          replay = await api(
            `${project(projectId)}/history/${step}`,
            HistoryReplaySchema,
            json("POST", {
              entryId: expectedHistoryId,
              expectedEntryId:
                expectedHistoryId === undefined ? target : undefined,
              requestId: crypto.randomUUID(),
              composition: here ? open.composition : undefined,
              withEntries,
              skip,
            }),
          );
        } catch (error) {
          if (painted && useTimeline.getState().view === painted)
            useTimeline.setState({ view: shown(projectId) });
          if (
            !(error instanceof ApiError) ||
            error.status !== 409 ||
            useTimeline.getState().projectId !== projectId
          )
            throw error;
          const refusal = HistoryConflictSchema.safeParse(error.body);
          const conflict = refusal.success ? refusal.data.conflict : undefined;
          const group = conflict?.undoTogether;
          const skipEntryId = conflict?.skipEntryId;
          const authors = [
            ...new Set(conflict?.blocking?.map(({ author }) => author.name)),
          ];
          if (error.code === "history-advanced") {
            if (target === unobservedNoteHistory.get(projectId))
              unobservedNoteHistory.delete(projectId);
            if (
              unobservedTimelineHistory?.projectId === projectId &&
              unobservedTimelineHistory.entryId === target
            )
              unobservedTimelineHistory = undefined;
            await refreshOpenTimeline(projectId, undefined, false);
          }
          const dismiss = showToast(
            group && authors.length
              ? `${error.message} This also takes back the ${group.withEntries.length === 1 ? "edit" : "edits"} by ${authors.join(", ")}.`
              : error.message,
            group
              ? {
                  label:
                    group.withEntries.length === 1
                      ? "Undo both"
                      : `Undo all ${group.withEntries.length + 1}`,
                  run: () => {
                    dismiss();
                    void stepHistory(
                      projectId,
                      "undo",
                      group.entryId,
                      group.withEntries,
                    ).catch((error: unknown) =>
                      reportEditorError("timeline", error),
                    );
                  },
                }
              : skipEntryId
                ? {
                    label: "Skip",
                    run: () => {
                      dismiss();
                      void stepHistory(
                        projectId,
                        "undo",
                        skipEntryId,
                        undefined,
                        true,
                      ).catch((error: unknown) =>
                        reportEditorError("timeline", error),
                      );
                    },
                  }
                : step === "redo"
                  ? { label: "Show changes", run: showHistoryChanges }
                  : null,
          );
          return;
        }
        const { entry, view, history } = replay;
        if (replay.skipped) {
          if (here && isOpen(projectId, open.composition)) {
            if (history && standing) settle(projectId, standing, history);
            else await refreshOpenTimeline(projectId, undefined, false);
            showToast(replay.skipped.label, null, { tone: "info" });
          }
          return;
        }
        if (!entry) {
          if (useTimeline.getState().projectId === projectId)
            showToast(
              replay.message ?? `Nothing of yours to ${step}.`,
              { label: "Show changes", run: showHistoryChanges },
              { tone: "info" },
            );
          return;
        }
        if (view && history && isOpen(projectId, view.composition)) {
          answers.set(view.composition, view);
          confirmed = { projectId, view };
          if (painted && standing)
            rememberHistoryPicture(entry.id, view, standing);
          settle(projectId, view, history);
        } else {
          await refreshOpenTimeline(projectId, undefined, false);
        }
        if (useTimeline.getState().projectId !== projectId) return;
        const redo = {
          label: "Redo",
          run: () => {
            showToast("");
            void stepHistory(projectId, "redo", entry.id).catch(
              (error: unknown) => reportEditorError("timeline", error),
            );
          },
        };
        const first = replay.removedNotes?.[0];
        if (first && replay.notesBefore) {
          dispatchNote(projectId, {
            type: "landed",
            ids: new Set(replay.removedNotes),
          });
          showToast(
            `Note ${noteNumbers(replay.notesBefore).get(first)} removed ·`,
            redo,
          );
        } else if (step === "undo") {
          const standing = entry.files.find(
            ({ path, before, after }) =>
              isMediaItem(path) && before === null && after,
          );
          const removed =
            standing &&
            entry.files.find(
              ({ before, after }) =>
                before === standing.after && after === null,
            );
          if (standing && removed) {
            const name = standing.path.split("/").at(-1);
            const from = removed.path.split("/").at(-1);
            showToast(
              inMediaTrash(removed.path)
                ? `Restored ${name} to Media.`
                : `Renamed ${from} back to ${name}.`,
              redo,
              { tone: "info" },
            );
          } else if (replay.kept) {
            const { count, authors } = replay.kept;
            showToast(
              `${entry.label.replace(/^Undid: /, "Undid ")}. Kept ${count} later ${count === 1 ? "edit" : "edits"} by ${authors.join(", ")}.`,
              redo,
              { tone: "info" },
            );
          }
        }
      }),
    ),
  );
  let history = pendingHistory.get(projectId);
  if (!history) {
    history = new Set();
    pendingHistory.set(projectId, history);
  }
  history.add(run);
  const release = () => {
    history.delete(run);
    if (!history.size) pendingHistory.delete(projectId);
  };
  void run.then(release, release);
  return run;
}

/** Whether clips have been copied in this project, so a paste has something to place. */
export const hasClipboard = (projectId: string) => clipboardIds.has(projectId);

/** Clipboard keys serialize copy/cut/paste, including a paste pressed before copy has answered. */
export function clipboardEdit(
  projectId: string,
  action: "copy" | "cut" | "overwrite" | "insert" | "attributes",
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
        clipboardSources.set(copied.id, {
          id:
            selection.anchor && selection.ids.has(selection.anchor)
              ? selection.anchor
              : clipIds[0]!,
          fps: seen.fps,
        });
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
      if (action === "attributes") {
        if (view?.composition !== useTimeline.getState().view?.composition)
          return;
        const copied = clipboards.get(clipboardId);
        const source = clipboardSources.get(clipboardId);
        if (!copied || !source) return;
        let skippedSpeed = 0;
        let noChanges = false;
        const accepted = await editTimeline(
          projectId,
          "Paste attributes",
          (timeline) => {
            if (
              timeline.fps.num * source.fps.den !==
              source.fps.num * timeline.fps.den
            )
              throw new TimelineError(
                "unsupported",
                "Paste requires timelines with the same frame rate.",
              );
            const result = pasteAttributes(
              timeline,
              copied,
              source.id,
              selection.ids,
            );
            skippedSpeed = result.skippedSpeed;
            noChanges = result.commands.length === 0;
            return result.commands;
          },
        );
        if (skippedSpeed && (accepted || noChanges))
          showToast(
            "Speed skipped where the copied clip or a destination has a speed ramp.",
            null,
            { tone: "info", transient: true },
          );
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

/** Only this tab's edits may show feedback through the live project event. */
export function receiveAnimationFeedback(
  projectId: string,
  data: unknown,
  signal: AbortSignal,
) {
  const feedback = AnimationFeedbackSchema.parse(data);
  if (feedback.origin !== tabOrigin) return;
  void queue.then(() => {
    if (!signal.aborted && useTimeline.getState().projectId === projectId)
      showAnimationFeedback(projectId, feedback);
  });
}
