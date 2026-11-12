import { useTrackResize } from "./heights";
import {
  MIN_TRACK_HEIGHT,
  MAX_TRACK_HEIGHT,
  trackDensities,
} from "../../shared/timeline/view";
import type { TimelineViewSettings } from "../../shared/timeline/view";
import { useWorkspace } from "../workspace";
import { voiceoverTrack } from "../../shared/voiceover";
import { ClipMix } from "./mix";
import { AudioMeters } from "./meters";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from "react";
import { flushSync } from "react-dom";
import {
  CursorClick,
  Eye,
  EyeSlash,
  LockSimple,
  LockSimpleOpen,
  Minus,
  Plus,
  Rows,
} from "@phosphor-icons/react";
import type {
  Clip,
  Fps,
  Marker,
  Timeline as TimelineData,
  Track,
} from "../../shared/timeline/schema";
import { clipVisible, trackMix } from "../../shared/timeline/tracks";
import {
  LABEL_SPACING,
  MAX_PPF,
  clipName,
  clipsByTrack,
  clipsInRange,
  majorTicks,
  mountedRange,
  rowsBetween,
  sliderToZoom,
  tickStep,
  timelineFrames,
  trackRows,
  zoomToSlider,
} from "./math";
import type { FrameRange, Row, RowSizes, TickStep } from "./math";
import { createBodies } from "./bodies";
import type { Bodies } from "./bodies";
import type { Tool } from "./gesture";
import { useLaneGestures } from "./lanes";
import { mediaDrag, subscribeMediaDrag } from "./mediaDrag";
import type { LaneGestureOptions } from "./lanes";
import type { Selection } from "./selection";
import { useClipMotion } from "./motion";
import { createViewport } from "./view";
import type { TimelineViewport } from "./view";
import { formatTimecode } from "../../shared/timeline/timecode";
import { useKeymap } from "../keymap";
import "./timeline.css";

declare module "react" {
  interface CSSProperties {
    [property: `--${string}`]: string | number;
  }
}

/** The transport as the timeline needs it. The playhead follows it without rendering React. */
export interface TimelineClock {
  frame(): number;
  /** The way playback runs: 1 forward, -1 in reverse, 0 when stopped or scrubbing. */
  direction(): 1 | 0 | -1;
  /** Calls back when the frame changes and at no other time, at most once per displayed frame. */
  subscribe(listener: () => void): () => void;
}
export interface TimelinePin {
  id: string;
  /** The note's number, as Review and the picture show it. */
  number: number;
  frame: number;
  state: "queued" | "working" | "review" | "accepted";
}
export interface TimelineProps {
  timeline: TimelineData;
  viewSettings: TimelineViewSettings;
  onViewSettings(settings: TimelineViewSettings): void;
  /** Where the clips' media is read from: filmstrips and waveforms come from this project's cache. */
  source: { projectId: string; composition: string };
  clock: TimelineClock;
  /** Review notes shown on the ruler's top edge. */
  pins: readonly TimelinePin[];
  agentChanges?: ReadonlySet<string>;
  selection: Selection;
  onSelect(selection: Selection): void;
  /** What a press on a clip does: move and resize, ripple and roll, or razor. */
  tool: Tool;
  /** Dragged edges jump to clip edges, the playhead, markers, and in and out. */
  snapping: boolean;
  /** A drag or drop ended in an edit: one undo step. */
  onEdit: LaneGestureOptions["onEdit"];
  onGesture: LaneGestureOptions["onGesture"];
  /** A click on a marker or pin. */
  onSeek(frame: number): void;
  onOpenMarker?(marker: Marker, anchor: { x: number; y: number }): void;
  /** The pointer is down on the ruler; called for the press and every move until `onScrubEnd`. */
  onScrub(frame: number): void;
  onScrubEnd(): void;
  /**
   * A track button was pressed. The track may be an empty one the timeline does not hold yet;
   * its index and kind are what it is shown as.
   */
  onToggleTrack(
    track: Track,
    setting: "locked" | "autoSelect" | "enabled" | "muted" | "solo",
  ): void;
  onRenameTrack(track: Track, name: string): void;
  onAddTrack(kind: Track["kind"]): void;
  recording?: { track: Track; start: number } | null;
  audioControls?(
    track: Track,
    id: string,
    part: "title" | "buttons",
  ): ReactNode;
  /** A pin was clicked; the playhead has already been sent to its frame. */
  onOpenPin(id: string): void;
}

/** One press of a zoom button or arrow key. */
const ZOOM_STEP = 1.5;

const pinLabels = {
  queued: "queued",
  working: "in progress",
  review: "ready to review",
  accepted: "accepted",
} as const satisfies Record<TimelinePin["state"], string>;

/** A clip name shows once its clip is this wide; timeline.css hides it below that. */
const NAME_MIN_WIDTH = 28;
/** A clip shows its duration once it is this wide. */
const LENGTH_MIN_WIDTH = 200;

interface Mounted {
  frames: FrameRange;
  rows: FrameRange;
  step: TickStep;
  /**
   * The closest zoom, in pixels per frame, before labels are mounted again: the next quarter
   * octave. Clips too narrow to show a name anywhere below it get no label, so a zoomed-out
   * timeline restyles one element per clip, not three.
   */
  labelPpf: number;
}

function readSizes(): {
  rows: RowSizes;
  head: number;
  compact: number;
  tall: { video: number; audio: number };
} {
  const style = getComputedStyle(document.documentElement);
  const px = (token: string) => parseFloat(style.getPropertyValue(token));
  return {
    rows: {
      video: px("--size-track-video"),
      audio: px("--size-track-audio"),
      seam: px("--stroke-hair"),
      divider: px("--stroke-rail"),
    },
    head: px("--size-track-head"),
    compact: px("--size-track-compact"),
    tall: {
      video: px("--size-track-video-tall"),
      audio: px("--size-track-audio-tall"),
    },
  };
}

const ClipBody = memo(function ClipBody({
  clip,
  row,
  selected,
}: {
  clip: Clip;
  row: Row;
  selected: boolean;
}) {
  return (
    <div
      className={`tl-clip ${clip.kind} on-${row.track.kind}${row.track.locked ? " locked" : ""}${clip.enabled ? "" : " disabled"}${selected ? " selected" : ""}`}
      data-clip={clip.id}
      style={{ "--s": clip.start, "--d": clip.duration, top: 0 }}
    />
  );
});

/** Drawn over the clip bodies' canvas, so the outline and its brackets stay whole on a filmstrip. */
const ClipOutline = memo(function ClipOutline({
  clip,
  row,
}: {
  clip: Clip;
  row: Row;
}) {
  return (
    <i
      className={`tl-selected on-${row.track.kind}`}
      data-clip-outline={clip.id}
      style={{ "--s": clip.start, "--d": clip.duration, top: 0 }}
    />
  );
});

const ClipLabel = memo(function ClipLabel({
  clip,
  row,
  fps,
  timed,
}: {
  clip: Clip;
  row: Row;
  fps: Fps;
  /** Whether the clip can get wide enough to show its duration before labels are mounted again. */
  timed: boolean;
}) {
  const end = clip.start + clip.duration;
  return (
    <div
      className={`tl-label${timed ? " timed" : ""}${row.track.locked ? " locked" : ""}${clip.enabled ? "" : " disabled"}`}
      data-clip-label={clip.id}
      data-kind={clip.kind}
      style={{ "--s": clip.start, "--d": clip.duration, top: 0 }}
    >
      <span
        className="tl-name"
        data-unscaled
        style={{ "--f": clip.start, "--e": end }}
      >
        {clipName(clip)}
      </span>
      {clip.textPreview && (
        <span className="tl-text-line">
          <span
            className="tl-name tl-text"
            data-unscaled
            style={{ "--f": clip.start, "--e": end }}
            title={clip.textPreview}
          >
            {clip.textPreview}
          </span>
        </span>
      )}
      {timed && (
        <span className="tl-length" data-unscaled style={{ "--f": end }}>
          {formatTimecode(clip.duration, fps)}
        </span>
      )}
    </div>
  );
});

const Ruler = memo(function Ruler({
  frames,
  step,
  fps,
  end,
  markers,
  pins,
  range,
  labels,
  onSeek,
  onOpenPin,
  onOpenMarker,
}: {
  /** The element holding the timecode labels, which the view writes its scroll offset to. */
  labels: RefObject<HTMLDivElement | null>;
  frames: FrameRange;
  step: TickStep;
  fps: Fps;
  end: number;
  markers: readonly Marker[];
  pins: readonly TimelinePin[];
  range: TimelineData["range"];
  onSeek(frame: number): void;
  onOpenPin(id: string): void;
  onOpenMarker?: TimelineProps["onOpenMarker"];
}) {
  const ticks = majorTicks(frames, step.major);
  const minors = step.minor ? step.major / step.minor : 0;
  const shown = (frame: number) => frame >= frames.from && frame < frames.to;
  const marked = range.in !== null || range.out !== null;
  const from = range.in ?? 0;
  // A marker's name ends before the next thing on the ruler's bottom band.
  const stops = [
    ...markers.map((marker) => marker.frame),
    ...(range.in === null ? [] : [range.in]),
    ...(range.out === null ? [] : [range.out]),
  ].sort((a, b) => a - b);
  return (
    <>
      <div className="tl-time">
        <div className="tl-scaled">
          {marked && (
            <i
              className="tl-range"
              style={{ "--f": from, "--d": (range.out ?? end) - from }}
            />
          )}
          {ticks.map((frame) => (
            <span
              key={frame}
              className="tl-tick"
              style={{ "--f": frame, "--step": step.major }}
            >
              {Array.from({ length: Math.max(0, minors - 1) }, (_, index) => (
                <i key={index} style={{ "--n": (index + 1) / minors }} />
              ))}
            </span>
          ))}
        </div>
        <div className="tl-tick-labels" ref={labels}>
          {ticks.map((frame) => (
            <span
              key={frame}
              className="tl-tick-label"
              data-unscaled
              style={{ "--f": frame }}
            >
              {formatTimecode(frame, fps)}
            </span>
          ))}
        </div>
      </div>
      {range.in !== null && (
        <i
          className="tl-bracket in"
          data-unscaled
          style={{ "--f": range.in }}
        />
      )}
      {range.out !== null && (
        <i
          className="tl-bracket out"
          data-unscaled
          style={{ "--f": range.out }}
        />
      )}
      {markers
        .filter((marker) => shown(marker.frame))
        .map((marker) => (
          <button
            key={marker.id}
            className={`tl-marker ${marker.color}`}
            data-unscaled
            style={{
              "--f": marker.frame,
              "--next": stops.find((frame) => frame > marker.frame) ?? end * 2,
            }}
            title={[marker.name, marker.note, "Double-click to edit"]
              .filter(Boolean)
              .join("\n")}
            aria-label={`Marker ${marker.name || formatTimecode(marker.frame, fps)}`}
            onClick={() => onSeek(marker.frame)}
            onDoubleClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              onOpenMarker?.(marker, { x: box.left, y: box.bottom });
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              const box = event.currentTarget.getBoundingClientRect();
              onOpenMarker?.(marker, { x: box.left, y: box.bottom });
            }}
          >
            {marker.name && <span>{marker.name}</span>}
          </button>
        ))}
      {pins
        .filter((pin) => shown(pin.frame))
        .map((pin) => (
          <button
            key={pin.id}
            className={`tl-pin ${pin.state}`}
            data-unscaled
            style={{ "--f": pin.frame }}
            title={`Note ${pin.number}`}
            aria-label={`Review note ${pin.number} at ${formatTimecode(pin.frame, fps)}, ${pinLabels[pin.state]}`}
            onClick={() => {
              onSeek(pin.frame);
              onOpenPin(pin.id);
            }}
          />
        ))}
    </>
  );
});

const TrackHeads = memo(function TrackHeads({
  rows,
  onToggleTrack,
  onRenameTrack,
  audioControls,
  resize,
  onHeight,
}: {
  rows: readonly Row[];
  onToggleTrack: TimelineProps["onToggleTrack"];
  onRenameTrack: TimelineProps["onRenameTrack"];
  audioControls: TimelineProps["audioControls"];
  resize: ReturnType<typeof useTrackResize>;
  onHeight(row: Row, height: number): void;
}) {
  return rows.map((row) => {
    const { track, id, top, height } = row;
    return (
      <div
        key={track.index}
        className={`tl-head ${track.kind}`}
        data-row={track.index}
        data-compact={height < 40 ? "" : undefined}
        style={{ top, height: height + 1 }}
      >
        <div className="tl-head-title">
          <span className="tl-head-id">{id}</span>
          <input
            key={`${track.index}:${track.name}`}
            className="tl-head-name"
            aria-label={`Name ${id}`}
            title="Rename track"
            maxLength={200}
            defaultValue={track.name ?? ""}
            placeholder={`${track.kind === "video" ? "Video" : "Audio"} ${id.slice(1)}`}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => {
              const name = event.currentTarget.value.trim();
              if (name !== (track.name ?? "")) onRenameTrack(track, name);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape")
                event.currentTarget.value = track.name ?? "";
              if (event.key === "Enter" || event.key === "Escape")
                event.currentTarget.blur();
            }}
          />
          {track.kind === "audio" && audioControls?.(track, id, "title")}
        </div>
        <div className="tl-head-buttons">
          <button
            className={`tl-track-button${track.locked ? " exception" : ""}`}
            aria-label={`Lock ${id}`}
            aria-pressed={track.locked}
            title={track.locked ? "Unlock track" : "Lock track"}
            onClick={() => onToggleTrack(track, "locked")}
          >
            {track.locked ? (
              <LockSimple size={13} weight="fill" />
            ) : (
              <LockSimpleOpen size={13} />
            )}
          </button>
          <button
            className={`tl-track-button${track.autoSelect ? "" : " exception"}`}
            aria-label={`Auto-select ${id}`}
            aria-pressed={track.autoSelect}
            title={
              track.autoSelect ? "Turn auto-select off" : "Turn auto-select on"
            }
            onClick={() => onToggleTrack(track, "autoSelect")}
          >
            <CursorClick
              size={13}
              weight={track.autoSelect ? "fill" : "regular"}
            />
          </button>
          {track.kind === "video" ? (
            <button
              className={`tl-track-button${track.enabled ? "" : " exception"}`}
              aria-label={`Enable ${id}`}
              aria-pressed={track.enabled}
              title={
                track.enabled ? "Disable video track" : "Enable video track"
              }
              onClick={() => onToggleTrack(track, "enabled")}
            >
              {track.enabled ? (
                <Eye size={13} />
              ) : (
                <EyeSlash size={13} weight="fill" />
              )}
            </button>
          ) : (
            <>
              <button
                className={`tl-track-button${track.muted ? " exception" : ""}`}
                aria-label={`Mute ${id}`}
                aria-pressed={track.muted}
                title="Mute track"
                onClick={() => onToggleTrack(track, "muted")}
              >
                M
              </button>
              <button
                className={`tl-track-button${track.solo ? " exception" : ""}`}
                aria-label={`Solo ${id}`}
                aria-pressed={track.solo}
                title="Solo track (also in export)"
                onClick={() => onToggleTrack(track, "solo")}
              >
                S
              </button>
              {audioControls?.(track, id, "buttons")}
            </>
          )}
        </div>
        <div
          className="tl-track-resize"
          role="separator"
          aria-label={`Height ${id}`}
          aria-orientation="horizontal"
          aria-valuemin={MIN_TRACK_HEIGHT}
          aria-valuemax={MAX_TRACK_HEIGHT}
          aria-valuenow={height}
          tabIndex={0}
          title="Drag to resize track. Arrow keys adjust height."
          onPointerDown={(event) => resize.start(event, row)}
          onPointerMove={resize.move}
          onPointerUp={() => resize.finish(true)}
          onPointerCancel={() => resize.finish(false)}
          onLostPointerCapture={() => resize.finish(false)}
          onKeyDown={(event) => {
            const change =
              event.key === "ArrowUp" ? -4 : event.key === "ArrowDown" ? 4 : 0;
            if (!change && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            event.stopPropagation();
            onHeight(
              row,
              event.key === "Home"
                ? MIN_TRACK_HEIGHT
                : event.key === "End"
                  ? MAX_TRACK_HEIGHT
                  : Math.max(
                      MIN_TRACK_HEIGHT,
                      Math.min(MAX_TRACK_HEIGHT, height + change),
                    ),
            );
          }}
        />
      </div>
    );
  });
});

/**
 * The timeline read view: ruler, track headers, clips, markers, review pins and the playhead.
 * Scrolling and zooming write to the DOM directly; React renders only when the view leaves the
 * range of frames and rows it has mounted.
 */
export function Timeline({
  timeline,
  viewSettings,
  onViewSettings,
  source,
  clock,
  pins,
  agentChanges,
  selection,
  onSelect,
  tool,
  snapping,
  onEdit,
  onGesture,
  onSeek,
  onScrub,
  onScrubEnd,
  onToggleTrack,
  audioControls,
  recording,
  onRenameTrack,
  onAddTrack,
  onOpenPin,
  onOpenMarker,
}: TimelineProps) {
  const [takeTrack, setTakeTrack] = useState<Track | null>(null);
  useLayoutEffect(() => {
    if (!recording) {
      setTakeTrack(null);
      return;
    }
    let index: number | undefined;
    const write = () => {
      const destination = voiceoverTrack(
        timeline,
        recording.track,
        recording.start,
        Math.max(1, clock.frame() - recording.start),
      );
      if (destination.index === index) return;
      index = destination.index;
      setTakeTrack(destination);
    };
    write();
    return clock.subscribe(write);
  }, [timeline, recording, clock]);
  const ghost =
    recording &&
    takeTrack &&
    takeTrack.index !== recording.track.index &&
    !timeline.tracks.some((track) => track.index === takeTrack.index)
      ? takeTrack.index
      : undefined;
  const shownTracks = useMemo(
    () =>
      recording &&
      takeTrack &&
      !timeline.tracks.some((track) => track.index === takeTrack.index)
        ? [...timeline.tracks, takeTrack]
        : timeline.tracks,
    [timeline.tracks, takeTrack, recording],
  );
  const [sizes] = useState(readSizes);
  const [mounted, setMounted] = useState<Mounted | null>(null);
  const [trackMenu, setTrackMenu] = useState<{
    x: number;
    y: number;
    track?: Track;
  } | null>(null);
  useEffect(() => {
    if (!trackMenu) return;
    const close = () => setTrackMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [trackMenu]);
  const menuTrack = trackMenu?.track;
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLElement>(null);
  const playheadHead = useRef<HTMLElement>(null);
  const takeRegion = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tickLabels = useRef<HTMLDivElement>(null);
  const bodies = useRef<Bodies | null>(null);
  const lanes = useRef<HTMLDivElement>(null);
  const viewport = useRef<TimelineViewport | null>(null);
  const scrubbing = useRef(false);

  const { fps } = timeline;
  const frames = timelineFrames(timeline);
  const [trackDrag, setTrackDrag] = useState(false);
  const draggingMedia =
    useSyncExternalStore(subscribeMediaDrag, mediaDrag) !== null;
  const rowSizes = useMemo(
    () => ({
      ...sizes.rows,
      ...(viewSettings.density === "compact"
        ? { video: sizes.compact, audio: sizes.compact }
        : viewSettings.density === "tall"
          ? sizes.tall
          : {}),
      heights: viewSettings.heights,
      // Clip moves reveal the bands when the pointer reaches an edge.
      dropZones: draggingMedia || trackDrag,
    }),
    [sizes, viewSettings, draggingMedia, trackDrag],
  );
  const layout = useMemo(
    () => trackRows(shownTracks, rowSizes),
    [shownTracks, rowSizes],
  );
  const tracks = useMemo(() => clipsByTrack(timeline.clips), [timeline.clips]);
  const resize = useTrackResize({
    root: grid,
    tracks: shownTracks,
    sizes: rowSizes,
    layout,
    settings: viewSettings,
    save: onViewSettings,
    draw: (next) => {
      const view = viewport.current?.state();
      if (view) bodies.current?.view(view);
      bodies.current?.scene({ rows: next.rows, tracks, fps });
    },
  });
  const gestures = useLaneGestures({
    timeline,
    rows: layout.rows,
    newRows: layout.newRows,
    tracks,
    selection,
    tool,
    snapping,
    lanes,
    viewport,
    bodies,
    playhead: clock.frame,
    onSelect,
    onEdit,
    onGesture,
    onTrackDrag: setTrackDrag,
  });
  const refreshDrag = useRef(gestures.refresh);
  refreshDrag.current = gestures.refresh;

  useLayoutEffect(() => {
    if (!canvas.current) return;
    const created = createBodies(
      canvas.current,
      source.projectId,
      source.composition,
    );
    bodies.current = created;
    created.versions(useWorkspace.getState().fileChanges);
    const unsubscribe = useWorkspace.subscribe(({ fileChanges }, previous) => {
      if (fileChanges !== previous.fileChanges) created.versions(fileChanges);
    });
    const view = viewport.current?.state();
    if (view) created.view(view);
    return () => {
      unsubscribe();
      created.destroy();
      bodies.current = null;
    };
  }, [source.projectId, source.composition]);
  useLayoutEffect(() => {
    bodies.current?.scene({ rows: layout.rows, tracks, fps });
    // Opening an edge band changes row positions; redraw the held filmstrip afterward.
    if (trackDrag) refreshDrag.current();
  }, [source.projectId, source.composition, layout, tracks, fps, trackDrag]);

  useLayoutEffect(() => {
    if (!scroller.current || !grid.current) return;
    const created = createViewport(
      scroller.current,
      grid.current,
      sizes.head,
      (flush) => {
        const state = created.state();
        bodies.current?.view(state);
        // Labels start 4px right of their ticks.
        tickLabels.current?.style.setProperty(
          "--cut",
          String(state.frames.from - 4 / state.ppf),
        );
        tickLabels.current?.style.setProperty(
          "--cut-end",
          String(state.frames.to - LABEL_SPACING / state.ppf),
        );
        const position = zoomToSlider(state.ppf, state.fit);
        slider.current?.style.setProperty("--zoom", String(position));
        slider.current?.setAttribute(
          "aria-valuenow",
          String(Math.round(position * 100)),
        );
        const update = () =>
          setMounted((current) => {
            const next = {
              frames: mountedRange(current?.frames ?? null, state.frames),
              rows: mountedRange(current?.rows ?? null, state.rows),
              step: tickStep(state.ppf, state.fps),
              labelPpf: 2 ** (Math.ceil(Math.log2(state.ppf) * 4) / 4),
            };
            return current &&
              current.frames === next.frames &&
              current.rows === next.rows &&
              current.step.major === next.step.major &&
              current.labelPpf === next.labelPpf
              ? current
              : next;
          });
        if (flush) flushSync(update);
        else update();
        refreshDrag.current();
      },
    );
    viewport.current = created;
    return () => {
      created.destroy();
      viewport.current = null;
    };
  }, [sizes]);

  useClipMotion(
    lanes,
    timeline.clips,
    layout.rows,
    () => viewport.current?.state().ppf ?? 0,
    (slides) => bodies.current?.slide(slides),
    gestures.held,
  );
  useLayoutEffect(() => {
    viewport.current?.measure({
      frames,
      fps: { num: fps.num, den: fps.den },
    });
  }, [frames, fps.num, fps.den]);

  useEffect(() => {
    const write = () => {
      const frame = clock.frame();
      playhead.current?.style.setProperty("--f", String(frame));
      playheadHead.current?.style.setProperty("--f", String(frame));
      if (!scrubbing.current)
        viewport.current?.follow(frame, clock.direction());
    };
    write();
    return clock.subscribe(write);
  }, [clock]);

  useEffect(() => {
    if (!recording) return;
    const write = () => {
      if (takeRegion.current)
        takeRegion.current.style.transform = `scaleX(${Math.max(0, clock.frame() - recording.start) / Math.max(1, frames)})`;
    };
    write();
    return clock.subscribe(write);
  }, [clock, recording, frames, takeTrack]);

  function zoomTo(position: number, animate: boolean) {
    const view = viewport.current;
    if (!view) return;
    view.zoomTo(
      sliderToZoom(position, view.state().fit),
      clock.frame(),
      animate,
    );
  }
  function sliderPosition(event: PointerEvent<HTMLDivElement>) {
    const track = event.currentTarget.getBoundingClientRect();
    const thumb =
      event.currentTarget.firstElementChild?.getBoundingClientRect().width ?? 0;
    return (event.clientX - track.left - thumb / 2) / (track.width - thumb);
  }
  function stepZoom(factor: number) {
    const view = viewport.current;
    view?.zoomTo(view.state().ppf * factor, clock.frame());
  }
  useKeymap({
    viewZoomSubZoomIn: () => stepZoom(ZOOM_STEP),
    viewZoomSubZoomOut: () => stepZoom(1 / ZOOM_STEP),
    viewZoomSubZoomToFit: () => viewport.current?.toggleFit(clock.frame()),
  });
  function zoomKey(event: KeyboardEvent) {
    const view = viewport.current;
    if (!view) return;
    const { ppf, fit } = view.state();
    const targets: Record<string, number> = {
      ArrowRight: ppf * ZOOM_STEP,
      ArrowUp: ppf * ZOOM_STEP,
      ArrowLeft: ppf / ZOOM_STEP,
      ArrowDown: ppf / ZOOM_STEP,
      Home: fit,
      End: MAX_PPF,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    // The transport binds the same keys; on the slider they zoom and nothing else.
    event.preventDefault();
    event.stopPropagation();
    view.zoomTo(target, clock.frame());
  }

  function scrub(event: PointerEvent) {
    const frame = viewport.current?.frameAtClient(event.clientX) ?? 0;
    onScrub(Math.min(frames, frame));
  }
  function endScrub() {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    onScrubEnd();
  }

  const rows = mounted
    ? rowsBetween(layout.rows, mounted.rows.from, mounted.rows.to)
    : [];
  const headRows =
    ghost === undefined
      ? rows
      : rows.filter((row) => row.track.index !== ghost);
  const suppressed = useMemo(
    () => trackMix(timeline.tracks).hidden,
    [timeline.tracks],
  );
  const clips = mounted
    ? rows.flatMap((row) => {
        const track = tracks.get(row.track.index);
        return track
          ? clipsInRange(track, mounted.frames).map((clip) => ({
              clip:
                clipVisible(clip, suppressed) === clip.enabled
                  ? clip
                  : { ...clip, enabled: false },
              row,
            }))
          : [];
      })
    : [];

  return (
    <div className="tl">
      <div className="tl-scroll" ref={scroller}>
        <div className="tl-grid" ref={grid} style={{ "--frames": frames }}>
          <div className="tl-corner">
            <button
              className="tl-zoom-step"
              aria-label="Zoom out"
              onClick={() => stepZoom(1 / ZOOM_STEP)}
            >
              <Minus size={12} />
            </button>
            <div
              className="tl-zoom"
              ref={slider}
              role="slider"
              tabIndex={0}
              aria-label="Zoom"
              aria-valuemin={0}
              aria-valuemax={100}
              title="Double-click to fit the timeline"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                // A press beside the thumb travels there; a drag follows the pointer directly.
                if (event.target === event.currentTarget)
                  zoomTo(sliderPosition(event), true);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  zoomTo(sliderPosition(event), false);
              }}
              onDoubleClick={() => viewport.current?.fit(clock.frame())}
              onKeyDown={zoomKey}
            >
              <i className="tl-zoom-thumb" />
            </div>
            <button
              className="tl-zoom-step"
              aria-label="Zoom in"
              onClick={() => stepZoom(ZOOM_STEP)}
            >
              <Plus size={12} />
            </button>
            <label
              className="tl-density-control"
              title={`Track density: ${Object.keys(viewSettings.heights).length ? "Custom" : viewSettings.density}`}
            >
              <Rows size={14} aria-hidden="true" />
              <select
                className="tl-density"
                aria-label="Track density"
                title="Set all track heights"
                value={
                  Object.keys(viewSettings.heights).length
                    ? "custom"
                    : viewSettings.density
                }
                onChange={(event) => {
                  const density = trackDensities.find(
                    (value) => value === event.target.value,
                  );
                  if (density) onViewSettings({ density, heights: {} });
                }}
              >
                {Object.keys(viewSettings.heights).length > 0 && (
                  <option value="custom" disabled>
                    Custom
                  </option>
                )}
                {trackDensities.map((density) => (
                  <option key={density} value={density}>
                    {density[0]!.toUpperCase() + density.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div
            className="tl-ruler"
            onPointerDown={(event) => {
              if (
                event.button !== 0 ||
                !(event.target instanceof Element) ||
                event.target.closest("button")
              )
                return;
              event.currentTarget.setPointerCapture(event.pointerId);
              scrubbing.current = true;
              scrub(event);
            }}
            onPointerMove={(event) => {
              if (scrubbing.current) scrub(event);
            }}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
          >
            {mounted && (
              <Ruler
                frames={mounted.frames}
                step={mounted.step}
                fps={fps}
                end={frames}
                markers={timeline.markers}
                pins={pins}
                range={timeline.range}
                labels={tickLabels}
                onSeek={onSeek}
                onOpenPin={onOpenPin}
                onOpenMarker={onOpenMarker}
              />
            )}
            <i className="tl-playhead-head" ref={playheadHead} data-unscaled />
          </div>
          <div
            className="tl-heads"
            style={{ minHeight: layout.height }}
            onContextMenu={(event) => {
              event.preventDefault();
              const head =
                event.target instanceof Element
                  ? event.target.closest<HTMLElement>(".tl-head[data-row]")
                  : null;
              setTrackMenu({
                x: Math.min(event.clientX, window.innerWidth - 180),
                y: Math.min(event.clientY, window.innerHeight - 105),
                track: head
                  ? timeline.tracks.find(
                      (track) => track.index === Number(head.dataset.row),
                    )
                  : undefined,
              });
            }}
          >
            <TrackHeads
              rows={headRows}
              onToggleTrack={onToggleTrack}
              onRenameTrack={onRenameTrack}
              audioControls={audioControls}
              resize={resize}
              onHeight={(row, height) =>
                onViewSettings({
                  ...viewSettings,
                  heights: {
                    ...viewSettings.heights,
                    [row.track.index]: height,
                  },
                })
              }
            />
            {rows
              .filter((row) => row.track.index === ghost)
              .map((row) => (
                <div
                  key={row.track.index}
                  className="tl-head audio vo-ghost-head"
                  data-row={row.track.index}
                  style={{ top: row.top, height: row.height + 1 }}
                  aria-label={`New audio lane ${row.id}`}
                >
                  <div className="tl-head-title">
                    <span className="tl-head-id">{row.id}</span>
                    <span>Voiceover</span>
                  </div>
                </div>
              ))}
            {trackMenu && (
              <div
                className="tl-track-menu"
                role="menu"
                aria-label="Add track"
                style={{ left: trackMenu.x, top: trackMenu.y }}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") event.stopPropagation();
                }}
              >
                {(["video", "audio"] as const).map((kind, index) => (
                  <button
                    key={kind}
                    role="menuitem"
                    autoFocus={index === 0}
                    onClick={() => {
                      onAddTrack(kind);
                      setTrackMenu(null);
                    }}
                  >
                    Add {kind} track
                  </button>
                ))}
                {menuTrack && (
                  <button
                    role="menuitem"
                    disabled={
                      menuTrack.locked ||
                      timeline.clips.some(
                        (clip) => clip.track === menuTrack.index,
                      ) ||
                      recording?.track.index === menuTrack.index
                    }
                    onClick={() => {
                      onEdit("Remove empty track", [
                        { type: "removeTrack", index: menuTrack.index },
                      ]);
                      setTrackMenu(null);
                    }}
                  >
                    Remove empty track
                  </button>
                )}
              </div>
            )}
            <i className="tl-divider" style={{ top: layout.dividerTop }} />
          </div>
          <div
            className="tl-lanes"
            ref={lanes}
            style={{ minHeight: layout.height }}
            data-tool={tool}
            {...gestures.handlers}
          >
            {rows.map((row) => (
              <i
                key={row.track.index}
                className={`tl-lane ${row.track.kind}`}
                data-row={row.track.index}
                style={{ top: row.top, height: row.height + 1 }}
              />
            ))}
            <i className="tl-divider" style={{ top: layout.dividerTop }} />
            <div className="tl-time">
              <div className="tl-scaled">
                {rows.map((row) => (
                  <div
                    className="tl-row"
                    key={row.track.index}
                    data-row={row.track.index}
                    style={{ top: row.top, height: row.height }}
                  >
                    {clips
                      .filter((item) => item.row === row)
                      .map(({ clip }) => (
                        <ClipBody
                          key={clip.id}
                          clip={clip}
                          row={row}
                          selected={selection.ids.has(clip.id)}
                        />
                      ))}
                  </div>
                ))}
                <canvas className="tl-bodies" ref={canvas} />
                {recording &&
                  layout.rows
                    .filter((row) => row.track.index === takeTrack?.index)
                    .map((row) => (
                      <div
                        key={row.track.index}
                        className="tl-row"
                        data-row={row.track.index}
                        style={{ top: row.top, height: row.height }}
                      >
                        <i
                          className="vo-take-region"
                          ref={takeRegion}
                          aria-label="Recording voiceover take"
                          style={{
                            "--s": recording.start,
                            "--d": Math.max(1, frames),
                          }}
                        />
                      </div>
                    ))}
                {rows.map((row) => {
                  const rowClips = clips.filter((item) => item.row === row);
                  return (
                    <div
                      className="tl-row"
                      key={row.track.index}
                      data-row={row.track.index}
                      style={{ top: row.top, height: row.height }}
                    >
                      {rowClips
                        .filter(({ clip }) => agentChanges?.has(clip.id))
                        .map(({ clip, row }) => (
                          <i
                            key={clip.id}
                            className={`tl-agent-change on-${row.track.kind}`}
                            data-agent-change={clip.id}
                            title="Agent change awaiting acceptance"
                            style={{
                              "--s": clip.start,
                              "--d": clip.duration,
                            }}
                          />
                        ))}
                      {rowClips
                        .filter(
                          ({ clip }) =>
                            clip.hasAudio &&
                            mounted &&
                            clip.duration * mounted.labelPpf >= NAME_MIN_WIDTH,
                        )
                        .map(({ clip, row }) => (
                          <ClipMix
                            key={clip.id}
                            clip={clip}
                            row={row}
                            fps={timeline.fps}
                            selected={selection.ids.has(clip.id)}
                          />
                        ))}
                      {rowClips.map(
                        ({ clip, row }) =>
                          selection.ids.has(clip.id) && (
                            <ClipOutline key={clip.id} clip={clip} row={row} />
                          ),
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="tl-names">
                {rows.map((row) => (
                  <div
                    className="tl-row"
                    key={row.track.index}
                    data-row={row.track.index}
                    style={{ top: row.top, height: row.height }}
                  >
                    {mounted &&
                      clips
                        .filter((item) => item.row === row)
                        .filter(
                          ({ clip }) =>
                            clip.duration * mounted.labelPpf >= NAME_MIN_WIDTH,
                        )
                        .map(({ clip, row }) => (
                          <ClipLabel
                            key={clip.id}
                            clip={clip}
                            row={row}
                            fps={fps}
                            timed={
                              clip.duration * mounted.labelPpf >=
                              LENGTH_MIN_WIDTH
                            }
                          />
                        ))}
                  </div>
                ))}
              </div>
            </div>
            {timeline.clips.length === 0 && (
              <p className="tl-empty">Drop media here</p>
            )}
            {[timeline.range.in, timeline.range.out].map(
              (frame, index) =>
                frame !== null && (
                  <i
                    key={index}
                    className="tl-range-line"
                    data-unscaled
                    style={{ "--f": frame }}
                  />
                ),
            )}
            <i className="tl-playhead" ref={playhead} data-unscaled />
            <div className="tl-pieces" ref={gestures.marks.pieces} />
            <div className="tl-ghost" ref={gestures.marks.ghost} hidden />
            <i className="tl-blade" ref={gestures.marks.bladeLine} hidden />
            <i className="tl-snap" ref={gestures.marks.snapLine} hidden />
            <div className="tl-marquee" ref={gestures.marks.marquee} hidden />
            <div className="tl-readout" ref={gestures.marks.readout} hidden />
          </div>
        </div>
      </div>
      <AudioMeters />
    </div>
  );
}
