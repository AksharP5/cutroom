import { localMediaPath } from "../../shared/media";
import { clipEnd, toFrames } from "../../shared/timeline/apply";
import type { Clip, Fps } from "../../shared/timeline/schema";
import { emptySelection } from "../timeline/selection";
import type { Selection } from "../timeline/selection";
import { showToast } from "../workspace";
import { ROOT_COMPOSITION, showComposition, useTimeline } from "./timeline";
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
}

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
 * given. One that is not open above this one opens from the root.
 */
export function openComposition(
  projectId: string,
  composition: string,
  seconds?: number,
) {
  const frame =
    seconds === undefined ? undefined : (fps: Fps) => toFrames(seconds, fps);
  const { parents } = useTimeline.getState();
  const index = parents.indexOf(composition);
  if (index >= 0)
    return go(projectId, composition, parents.slice(0, index), frame);
  go(
    projectId,
    composition,
    composition === ROOT_COMPOSITION ? [] : [ROOT_COMPOSITION],
    frame,
  );
}
