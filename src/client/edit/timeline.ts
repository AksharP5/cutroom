import { z } from "zod";
import { create } from "zustand";
import {
  TimelineError,
  apply,
  applyAll,
  randomClipId,
} from "../../shared/timeline/apply";
import {
  CommandSchema,
  TimelineViewSchema,
} from "../../shared/timeline/schema";
import type {
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
import { formatTimecode } from "./timecode";

const HistorySchema = z.object({ canUndo: z.boolean(), canRedo: z.boolean() });

/** The engine's timeline for the open composition, shared by the viewer, transport, and timeline. */
export const useTimeline = create(() => ({
  /** The project the views belong to; a read for another project is dropped. */
  projectId: null as string | null,
  /** The engine's last answer with the edits it has not answered yet applied on top. */
  view: null as TimelineView | null,
  history: { canUndo: false, canRedo: false },
  /** Selected clip ids. A clip id names one clip for good, so an id is that clip or gone. */
  selection: emptySelection as Selection,
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
let refusal = "";

/** Opens a project's timeline, dropping what was shown for the last one. */
export function openTimeline(projectId: string) {
  confirmed = null;
  pending = [];
  useTimeline.setState({ projectId, view: null, selection: emptySelection });
}

/**
 * Reads, edits, undo, and redo run one at a time. Each step starts from the view the previous one
 * left, so quick key presses never send a stale revision and a slow read never lands over a
 * newer view.
 */
function enqueue(step: () => Promise<void>) {
  const run = queue.then(step);
  queue = run.catch(() => {});
  return run;
}

/**
 * Applies commands to the view the user sees, naming every piece they cut with an id no clip has
 * had, in the commands' own `ids` lists. Commands apply one at a time, so each is named by itself.
 */
function name(commands: Command[], timeline: Timeline) {
  let current = timeline;
  const creates = new Set<string>();
  const named = commands.map((command): Command => {
    // Razors, inserts, and ripple trims and deletes through a spanning clip cut pieces.
    if (
      command.type !== "split" &&
      command.type !== "insert" &&
      command.type !== "trim" &&
      command.type !== "remove"
    ) {
      current = apply(current, command);
      return command;
    }
    const ids: Record<string, string[]> = { ...command.ids };
    let clipId = command.type === "insert" ? command.clip.id : undefined;
    current = apply(current, command, {
      newId: (base, from, taken) => {
        const id = randomClipId(base, from, taken);
        creates.add(id);
        if (from === null) clipId = id;
        else ids[from] = [...(ids[from] ?? []), id];
        return id;
      },
    });
    return command.type === "insert"
      ? { ...command, ids, clip: { ...command.clip, id: clipId } }
      : { ...command, ids };
  });
  return { commands: named, creates, timeline: current };
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
      try {
        return applyAll(current, edit.commands);
      } catch (error) {
        if (error instanceof TimelineError) return current;
        throw error;
      }
    }, view.timeline);
  return timeline === view.timeline ? view : { ...view, timeline };
}

async function read(projectId: string) {
  const [view, history] = await Promise.all([
    api(`${project(projectId)}/timeline`, TimelineViewSchema),
    api(`${project(projectId)}/history`, HistorySchema),
  ]);
  if (useTimeline.getState().projectId !== projectId) return view;
  confirmed = { projectId, view };
  useTimeline.setState({ view: shown(projectId), history });
  // The engine read this timeline, so an earlier refusal no longer stands.
  reportEditorError("timeline", null);
  return view;
}

export const loadTimeline = (projectId: string) =>
  enqueue(async () => {
    await read(projectId);
  });

/**
 * Sends an edit's commands as they were made. When someone else edited first the revision is
 * stale, so the server is read and the same commands are sent again; they still apply when the
 * other edit left their clips alone, as with a marker after an agent's marker.
 */
async function send(edit: Edit) {
  for (const retry of [false, true]) {
    const base =
      !retry && confirmed?.projectId === edit.projectId
        ? confirmed.view
        : await read(edit.projectId);
    try {
      await api(
        `${project(edit.projectId)}/commands`,
        TimelineViewSchema,
        json("POST", {
          composition: base.composition,
          expectedRevision: base.revision,
          label: edit.label,
          commands: edit.commands,
        }),
      );
      return;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.status === 409 && !retry) continue;
      if (error.status === 409)
        throw new Error("An agent edited first. Press it again.");
      // The commands applied to the view the user saw, so the engine refusing them here means
      // the clips changed since. Checks only the server makes, such as exact readback, keep
      // their own reason.
      if (error.status === 422 && error.code !== "unsupported")
        throw new Error("An agent changed those clips first. Press it again.");
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
  const names = new Map(
    timeline.clips
      .filter((clip) => clipName(clip) !== clip.id)
      .map((clip) => [clip.id, clipName(clip)]),
  );
  const ids = [...names.keys()].sort((a, b) => b.length - a.length);
  const withNames = ids.length
    ? text.replace(
        new RegExp(
          `(?<![\\w.-])(?:${ids.map(escaped).join("|")})(?![\\w-])`,
          "g",
        ),
        (id) => names.get(id) ?? id,
      )
    : text;
  return withNames
    .replace(
      /\btrack (\d+)\b/g,
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
) {
  const { view, projectId: open } = useTimeline.getState();
  if (!view || open !== projectId) return;
  let edit: Edit | null = null;
  try {
    const input = z.array(CommandSchema).parse(build(view.timeline));
    if (!input.length) return;
    const { commands, creates, timeline } = name(input, view.timeline);
    edit = {
      projectId,
      label,
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
      dropped: false,
    };
    const made = edit;
    useTimeline.setState({ view: { ...view, timeline } });
    pending.push(made);
    await enqueue(async () => {
      // An edit that made a clip this one names was refused, and both were taken back.
      if (made.dropped) return;
      try {
        await send(made);
      } catch (error) {
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
    if (!made.dropped && refusal && useWorkspace.getState().toast === refusal)
      showToast("");
  } catch (error) {
    if (edit) pending = pending.filter((item) => item !== edit);
    if (useTimeline.getState().projectId !== projectId) return;
    const shownView = shown(projectId);
    if (shownView) useTimeline.setState({ view: shownView });
    refusal = humanReason(
      error instanceof Error ? error.message : String(error),
      view.timeline,
    );
    showToast(refusal);
  }
}

export const stepHistory = (projectId: string, step: "undo" | "redo") =>
  enqueue(async () => {
    await api(
      `${project(projectId)}/history/${step}`,
      z.unknown(),
      json("POST"),
    );
    await read(projectId);
  });
