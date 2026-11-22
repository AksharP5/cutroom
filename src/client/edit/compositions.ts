import { z } from "zod";
import { localMediaPath } from "../../shared/media";
import { isTimelinePath } from "../../shared/sourcePaths";
import { clipEnd, toFrames } from "../../shared/timeline/apply";
import type { Clip, Fps } from "../../shared/timeline/schema";
import { emptySelection } from "../timeline/selection";
import type { Selection } from "../timeline/selection";
import { api, json } from "../api";
import { showToast } from "../workspace";
import {
  ROOT_COMPOSITION,
  onCompositionGone,
  onTimelineRenamed,
  showComposition,
  useTimeline,
} from "./timeline";
import { transport, useTransport } from "./transport";

/** Where each composition's playhead and selection were when it was last left, by project. */
const levels = new Map<string, { frame: number; selection: Selection }>();
const level = (projectId: string, composition: string) =>
  `${projectId}\n${composition}`;

/**
 * Edits `composition` in the same editor. The level left keeps its playhead and selection for
 * the way back. The playhead goes to `frame` at the composition's rate when given, otherwise
 * where it was left, or the start.
 */
function go(
  projectId: string,
  composition: string,
  parents: readonly string[],
  frame?: (fps: Fps) => number,
) {
  const state = useTimeline.getState();
  if (state.projectId !== projectId || state.composition === composition)
    return;
  levels.set(level(projectId, state.composition), {
    frame: useTransport.getState().frame,
    selection: state.selection,
  });
  const saved = levels.get(level(projectId, composition));
  transport.dispatch({ type: "stop" });
  // The shown document is about to be replaced; the playhead waits for the new one.
  transport.suspend();
  const seek = () => {
    const { composition: open, view } = useTimeline.getState();
    if (open === composition && view)
      transport.seek(frame?.(view.timeline.fps) ?? saved?.frame ?? 0);
  };
  const reading = showComposition(
    projectId,
    composition,
    parents,
    saved?.selection ?? emptySelection,
  );
  // A composition seen before shows at once; a new one once it is read.
  const opened = useTimeline.getState().composition === composition;
  if (opened) seek();
  void (opened ? reading : reading.then(seek)).catch((error: unknown) =>
    showToast(error instanceof Error ? error.message : String(error)),
  );
  // The project reopens on the timeline last shown.
  if (!parents.length)
    void api(
      `/projects/${encodeURIComponent(projectId)}/timeline-open`,
      TimelinePathSchema,
      json("PUT", { composition }),
    ).catch((error: unknown) => console.warn("Open timeline", error));
}

const TimelinePathSchema = z.object({ composition: z.string() });

/** The timeline a project reopens on: the one last shown, or index.html. */
export const lastTimeline = (projectId: string, signal: AbortSignal) =>
  api(
    `/projects/${encodeURIComponent(projectId)}/timeline-open`,
    TimelinePathSchema,
    { signal },
  ).then(
    ({ composition }) => composition,
    (error: unknown) => {
      if (!signal.aborted) console.warn("Open timeline", error);
      return ROOT_COMPOSITION;
    },
  );

/** Copies a timeline beside it in one undo step. The copy shows in the Compositions list. */
export const duplicateTimeline = (projectId: string, composition: string) =>
  void api(
    `/projects/${encodeURIComponent(projectId)}/timelines/duplicate`,
    TimelinePathSchema,
    json("POST", { composition }),
  ).catch((error: unknown) =>
    showToast(error instanceof Error ? error.message : String(error)),
  );

/** Adds an empty timeline in one undo step and opens it. */
export const newTimeline = (projectId: string) =>
  void api(
    `/projects/${encodeURIComponent(projectId)}/timelines`,
    TimelinePathSchema,
    json("POST", {}),
  ).then(
    ({ composition }) => openComposition(projectId, composition),
    (error: unknown) =>
      showToast(error instanceof Error ? error.message : String(error)),
  );

/** Timelines on their way to a new name, by level key: the editor waits for it instead of leaving. */
const renaming = new Set<string>();

/** Renames a timeline in one undo step. The editor keeps showing it under its new name. */
export async function renameTimeline(
  projectId: string,
  composition: string,
  name: string,
) {
  const key = level(projectId, composition);
  renaming.add(key);
  try {
    const renamed = await api(
      `/projects/${encodeURIComponent(projectId)}/timelines/rename`,
      TimelinePathSchema,
      json("POST", { composition, name }),
    );
    followTimeline(projectId, composition, renamed.composition);
    return renamed.composition;
  } finally {
    renaming.delete(key);
  }
}

/** Keeps editing a timeline whose file moved, at the same frame and selection. */
function followTimeline(projectId: string, from: string, to: string) {
  const state = useTimeline.getState();
  if (state.projectId !== projectId || from === to) return;
  const left = levels.get(level(projectId, from));
  if (left) levels.set(level(projectId, to), left);
  if (state.parents.includes(from)) {
    useTimeline.setState({
      parents: state.parents.map((path) => (path === from ? to : path)),
    });
    return;
  }
  if (state.composition !== from) return;
  levels.set(level(projectId, to), {
    frame: useTransport.getState().frame,
    selection: state.selection,
  });
  go(projectId, to, []);
}
onTimelineRenamed(followTimeline);

// A timeline whose file went away, as when its duplication is undone, leaves for the main one.
onCompositionGone((projectId) => {
  if (!renaming.has(level(projectId, useTimeline.getState().composition)))
    go(projectId, ROOT_COMPOSITION, []);
});

/** The project file a sub-composition host plays, or null for any other clip. */
export function hostedComposition(clip: Clip, composition: string) {
  return clip.kind === "composition" && clip.src
    ? localMediaPath(composition, clip.src)
    : null;
}

/**
 * Opens the composition a host clip plays, at the frame under the playhead when the playhead is
 * on the clip. False when the clip hosts none.
 */
export function openHost(projectId: string, clip: Clip) {
  const { composition, parents, view } = useTimeline.getState();
  const path = hostedComposition(clip, composition);
  if (!path || !view) return false;
  if (path === composition || parents.includes(path)) {
    showToast(`${path} is already open above this one.`, null, {
      tone: "info",
      transient: true,
    });
    return true;
  }
  const at = useTransport.getState().frame;
  // A level opened before keeps its playhead; the first visit starts at the frame the parent shows.
  const first =
    !levels.has(level(projectId, path)) &&
    at >= clip.start &&
    at < clipEnd(clip);
  const mediaStart = clip.mediaStart ?? 0;
  go(
    projectId,
    path,
    [...parents, composition],
    first
      ? (fps) =>
          toFrames(mediaStart, fps) +
          Math.round((at - clip.start) * clip.playbackRate)
      : undefined,
  );
  return true;
}

/** Returns to a composition this one was opened from, by default the one just above. */
export function leaveComposition(projectId: string, to?: string) {
  const { parents } = useTimeline.getState();
  const index = to === undefined ? parents.length - 1 : parents.indexOf(to);
  const target = parents[index];
  if (target === undefined) return false;
  go(projectId, target, parents.slice(0, index));
  return true;
}

/**
 * Opens any composition of the project, from a note or the composition list, at `seconds` when
 * given. A timeline opens in place of the one shown, as its equal. A scene that is not open above
 * this one opens from the timeline being edited.
 */
export function openComposition(
  projectId: string,
  composition: string,
  seconds?: number,
) {
  const frame =
    seconds === undefined ? undefined : (fps: Fps) => toFrames(seconds, fps);
  const { parents, composition: open } = useTimeline.getState();
  const index = parents.indexOf(composition);
  if (index >= 0)
    return go(projectId, composition, parents.slice(0, index), frame);
  go(
    projectId,
    composition,
    isTimelinePath(composition) ? [] : [parents[0] ?? open],
    frame,
  );
}
