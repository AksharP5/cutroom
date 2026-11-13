import { create } from "zustand";
import { frameTime, toFrames } from "../../shared/timeline/apply";
import { SourceViewSchema, emptySourceMarks } from "../../shared/timeline/view";
import { createViewPreferences } from "../viewPreferences";
import type { Timeline } from "../../shared/timeline/schema";
import { placedMedia } from "../timeline/gesture";
import type { MediaDrag } from "../timeline/mediaDrag";
import { showToast } from "../workspace";
import { placeAtPlayhead } from "./placeMedia";
import { createTransport, transport, useTransport } from "./transport";

type Marks = Timeline["range"];

/**
 * The media file loaded in the source viewer. It stays loaded while the viewer shows the
 * timeline, so Insert and Overwrite still place it.
 */
export const useSource = create(() => ({
  file: null as MediaDrag | null,
  /** The viewer shows the source instead of the timeline, and the transport keys drive it. */
  shown: false,
}));

const preferences = createViewPreferences(SourceViewSchema, () => ({
  ...emptySourceMarks(),
  identity: null,
}));

/** The source's own playhead, counted in frames at the timeline's rate. */
export const sourcePlayer = createTransport();

function sync() {
  const { file } = useSource.getState();
  if (!file) return;
  const { fps } = useTransport.getState();
  const duration = placedMedia(file, fps).frames;
  const marks = preferences.use.getState();
  const start =
    marks.in === null
      ? null
      : Math.min(duration - 1, Math.max(0, toFrames(marks.in, fps)));
  const out =
    marks.out === null
      ? null
      : Math.min(
          duration,
          Math.max((start ?? 0) + 1, toFrames(marks.out, fps)),
        );
  // Round saved seconds to this timeline's frames and keep them within the source.
  sourcePlayer.setTimeline({
    fps,
    duration,
    range: { in: start, out },
  });
}
useSource.subscribe(sync);
preferences.use.subscribe(sync);
useTransport.subscribe((state, previous) => {
  if (state.fps !== previous.fps) sync();
  // Scrubbing or playing the timeline is asking to see it.
  if (state.state.kind !== "stopped" && useSource.getState().shown)
    showSource(false);
});

const stop = (player: typeof transport) => {
  if (player.use.getState().state.kind !== "stopped")
    player.dispatch({ type: "stop" });
};

/** Loads a file and shows it. The same file keeps its place. */
export function openSource(file: MediaDrag) {
  stop(transport);
  useSource.setState({ file, shown: true });
}

/** Follows the mounted media's marks and reloads them when the media refreshes. */
export function openSourceMarks(projectId: string, path: string) {
  sourcePlayer.seek(0);
  let loaded = false;
  return preferences.open(
    projectId,
    `/projects/${encodeURIComponent(projectId)}/source-marks?path=${encodeURIComponent(path)}`,
    () => {
      if (loaded) return;
      loaded = true;
      // A late load must not move a playhead the owner has already moved.
      const { frame, state, range } = sourcePlayer.use.getState();
      if (frame === 0 && state.kind === "stopped")
        sourcePlayer.seek(range.in ?? 0);
    },
  );
}

/** Switches the viewer between the loaded source and the timeline; only one of them plays. */
export function showSource(shown: boolean) {
  if (!useSource.getState().file) return;
  stop(shown ? transport : sourcePlayer);
  useSource.setState({ shown });
}

export function closeSource() {
  stop(sourcePlayer);
  useSource.setState({ file: null, shown: false });
}

/** Sets the loaded file's marks, which it keeps while other files are open. */
export function markSource(range: Marks) {
  if (!useSource.getState().file) return;
  const { identity } = preferences.use.getState();
  if (identity === null) return;
  const { fps } = sourcePlayer.use.getState();
  preferences.save({
    identity,
    in: range.in === null ? null : frameTime(range.in, fps),
    out: range.out === null ? null : frameTime(range.out, fps),
  });
}

/** What Insert, Overwrite and a drag take from the loaded file: in to out, or all of it. */
export function sourceRange(): MediaDrag | null {
  const { file } = useSource.getState();
  if (!file) return null;
  const { fps, duration, range } = sourcePlayer.use.getState();
  const start = range.in ?? 0;
  return {
    ...file,
    start: frameTime(start, fps),
    seconds: frameTime((range.out ?? duration) - start, fps),
  };
}

/** Puts the loaded file's range on the timeline at the playhead. */
export function placeSource(projectId: string, mode: "insert" | "overwrite") {
  const media = sourceRange();
  if (media)
    return void placeAtPlayhead(projectId, media, mode, () =>
      showSource(false),
    );
  showToast("Open a file from Media to place it.", null, {
    tone: "info",
    transient: true,
  });
}
