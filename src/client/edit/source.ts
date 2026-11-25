import { frames } from "../../shared/timeline/piece";
import { create } from "zustand";
import { frameTime, toFrames } from "../../shared/timeline/apply";
import { SourceViewSchema, emptySourceMarks } from "../../shared/timeline/view";
import type { SourceMarks } from "../../shared/timeline/view";
import { createViewPreferences } from "../viewPreferences";
import type { Timeline } from "../../shared/timeline/schema";
import type { MediaInfo } from "../../shared/media";
import { placedMedia } from "../timeline/gesture";
import type { MediaDrag } from "../timeline/mediaDrag";
import { showToast } from "../workspace";
import type { SourcePlacement } from "./placeMedia";
import { placeLibraryAtPlayhead } from "./library";
import { placeAtPlayhead } from "./placeMedia";
import { ROOT_COMPOSITION } from "./timeline";
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
// Controls are usable before the first read supplies the media identity needed to save.
let pendingMarks: SourceMarks | null = null;
/** Where a newly opened file's playhead starts, for match frame; otherwise its in mark. */
let openingFrame: number | null = null;
/** An opening frame from Match Frame can arrive before the video clock is known. */
let matchedFrame: number | null = null;
/** A library item's marks, kept for the session: it is no project file to save them beside. */
const libraryMarks = new Map<string, SourceMarks>();

function sync() {
  const { file } = useSource.getState();
  if (!file) return;
  const { fps } = useTransport.getState();
  const duration = placedMedia(file, fps, ROOT_COMPOSITION).frames;
  const origin = file.start ?? 0;
  const marks = file.library
    ? (libraryMarks.get(file.library.name) ?? emptySourceMarks())
    : (pendingMarks ?? preferences.use.getState());
  const start =
    marks.in === null
      ? null
      : Math.min(duration - 1, Math.max(0, toFrames(marks.in - origin, fps)));
  const out =
    marks.out === null
      ? null
      : Math.min(
          duration,
          Math.max((start ?? 0) + 1, toFrames(marks.out - origin, fps)),
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

/** Loads a file and shows it, at `frame` when given. The same file otherwise keeps its place. */
export function openSource(file: MediaDrag, frame?: number) {
  stop(transport);
  const previous = useSource.getState().file;
  const loaded = previous?.path === file.path;
  const media =
    loaded && file.kind === "video" && file.codec === undefined
      ? previous
      : file;
  openingFrame = loaded ? null : (frame ?? null);
  useSource.setState({ file: media, shown: true });
  if (loaded && frame !== undefined) {
    const { fps } = sourcePlayer.use.getState();
    matchedFrame =
      media.kind === "video" && media.start === undefined ? frame : null;
    sourcePlayer.seek(frame - toFrames(media.start ?? 0, fps));
  }
  // A library item has no saved marks to read, which is where a file's playhead is placed.
  else if (!loaded && file.library) sourcePlayer.seek(frame ?? 0);
}

/** Follows the mounted media's marks and reloads them when the media refreshes. */
export function openSourceMarks(projectId: string, path: string) {
  pendingMarks = null;
  const opening = openingFrame;
  openingFrame = null;
  matchedFrame = opening;
  sourcePlayer.seek(opening ?? 0);
  let loaded = false;
  return preferences.open(
    projectId,
    `/projects/${encodeURIComponent(projectId)}/source-marks?path=${encodeURIComponent(path)}`,
    () => {
      const { identity } = preferences.use.getState();
      if (pendingMarks && identity !== null) {
        const marks = pendingMarks;
        pendingMarks = null;
        preferences.save({ identity, ...marks });
      }
      if (loaded || opening !== null) return;
      loaded = true;
      // A late load must not move a playhead the owner has already moved.
      const { frame, state, range } = sourcePlayer.use.getState();
      if (frame === 0 && state.kind === "stopped")
        sourcePlayer.seek(range.in ?? 0);
    },
  );
}

export function setSourceVideoTiming(video: NonNullable<MediaInfo["video"]>) {
  const { file } = useSource.getState();
  if (!file) return;
  const { frame, fps, state } = sourcePlayer.use.getState();
  const start = video.start ?? 0;
  const seconds = video.duration || file.seconds;
  const match = state.kind === "stopped" && matchedFrame === frame;
  matchedFrame = null;
  if (
    start !== file.start ||
    seconds !== file.seconds ||
    video.codec !== file.codec
  )
    useSource.setState({
      file: { ...file, start, seconds, codec: video.codec },
    });
  if (match && start !== 0) sourcePlayer.seek(frame - toFrames(start, fps));
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
  const { file } = useSource.getState();
  if (!file) return;
  const { identity } = preferences.use.getState();
  const { fps } = sourcePlayer.use.getState();
  // Saved marks use the file's media clock, including a late video's leading offset.
  const origin = file.start ?? 0;
  const marks = {
    in: range.in === null ? null : origin + frameTime(range.in, fps),
    out: range.out === null ? null : origin + frameTime(range.out, fps),
  };
  if (file.library) {
    libraryMarks.set(file.library.name, marks);
    sync();
    return;
  }
  if (identity === null) {
    pendingMarks = marks;
    sync();
    return;
  }
  preferences.save({ identity, ...marks });
}

/** What Insert, Overwrite and a drag take from the loaded file: in to out, or all of it. */
export function sourceRange(): MediaDrag | null {
  const { file } = useSource.getState();
  if (!file) return null;
  const { fps, duration, range } = sourcePlayer.use.getState();
  const start = range.in ?? 0;
  return {
    ...file,
    start: (file.start ?? 0) + frameTime(start, fps),
    seconds: frameTime((range.out ?? duration) - start, fps),
  };
}

/** Puts the loaded file's range on the timeline at the playhead. */
export function placeSource(projectId: string, mode: SourcePlacement) {
  const media = mode === "replace" ? useSource.getState().file : sourceRange();
  const { frame, fps } = sourcePlayer.use.getState();
  if (!media) {
    showToast("Open a file from Media to place it.", null, {
      tone: "info",
      transient: true,
    });
    return;
  }
  if (media.library) {
    const { range, duration } = sourcePlayer.use.getState();
    if (mode === "replace" || mode === "top") {
      showToast("Insert or overwrite a library item.", null, {
        tone: "info",
        transient: true,
      });
      return;
    }
    // In to out, or all of it: the clip plays the item from its In mark.
    const start = range.in ?? 0;
    void placeLibraryAtPlayhead(
      media.library,
      mode,
      (range.out ?? duration) - start,
      start,
    ).then(() => showSource(false));
    return;
  }
  // A history or MCP move can finish before the debounced Media listing refreshes.
  void fetch(
    `/api/projects/${encodeURIComponent(projectId)}/preview/${media.path.split("/").map(encodeURIComponent).join("/")}`,
    { method: "HEAD", cache: "no-store" },
  )
    .then((response) => {
      if (useSource.getState().file?.path !== media.path) return;
      if (!response.ok) {
        closeSource();
        throw new Error("Source media is no longer available.");
      }
      return placeAtPlayhead(
        projectId,
        media,
        mode,
        () => showSource(false),
        mode === "replace" ? frames(frame, fps) : undefined,
      );
    })
    .catch((error: unknown) =>
      showToast(error instanceof Error ? error.message : String(error)),
    );
}
