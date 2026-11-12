import { create } from "zustand";
import { frameTime } from "../../shared/timeline/apply";
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
  /** In and out for each file by path, in frames at the timeline's rate; out is exclusive. */
  marks: {} as Record<string, Marks>,
}));

/** The source's own playhead, counted in frames at the timeline's rate. */
export const sourcePlayer = createTransport();

function sync() {
  const { file, marks } = useSource.getState();
  if (!file) return;
  const { fps } = useTransport.getState();
  const duration = placedMedia(file, fps).frames;
  const { in: start = null, out = null } = marks[file.path] ?? {};
  // A file replaced by a shorter one keeps only the marks that still fit.
  sourcePlayer.setTimeline({
    fps,
    duration,
    range: {
      in: start !== null && start < duration ? start : null,
      out: out === null ? null : Math.min(out, duration),
    },
  });
}
useSource.subscribe(sync);
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

/** Loads a file and shows it, at its in mark or its first frame. The same file keeps its place. */
export function openSource(file: MediaDrag) {
  const { file: open, marks } = useSource.getState();
  stop(transport);
  useSource.setState({ file, shown: true });
  if (open?.path !== file.path) sourcePlayer.seek(marks[file.path]?.in ?? 0);
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
  const { file, marks } = useSource.getState();
  if (file) useSource.setState({ marks: { ...marks, [file.path]: range } });
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
  if (media) return void placeAtPlayhead(projectId, media, mode);
  showToast("Open a file from Media to place it.", null, {
    tone: "info",
    transient: true,
  });
}
