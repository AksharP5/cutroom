import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { mediaSettings, peakLevels } from "../../shared/media";
import { formatTimecode } from "../../shared/timeline/timecode";
import { mediaUrl } from "../api";
import { openContextMenu } from "../components/ContextMenu";
import { blurPointerButton, hint, keymap } from "../keymap";
import { PEAK_CHUNK, createTimelineMedia } from "../timeline/media";
import { MEDIA_DRAG_TYPE, setMediaDrag } from "../timeline/mediaDrag";
import type { MediaDrag } from "../timeline/mediaDrag";
import { reportEditorError, showToast, useWorkspace } from "../workspace";
import {
  closeSource,
  openSourceMarks,
  placeSource,
  sourcePlayer,
  sourceRange,
  useSource,
} from "./source";
import { ScrubMarks, ScrubTrack } from "./TransportBar";
import type { RuntimePlayer } from "./transport";

const edits = [
  {
    mode: "insert",
    label: "Insert",
    action: "editInsertOverwriteActionInsert",
  },
  {
    mode: "overwrite",
    label: "Overwrite",
    action: "editInsertOverwriteActionOverwrite",
  },
] as const;

/**
 * A seek lands just inside its frame, so a file at the timeline's own rate shows that frame and
 * not the one before it.
 */
const INSIDE_FRAME = 0.001;

/** How long a seek that draws no new frame holds the next one back. */
const PRESENT_MS = 100;

/**
 * A media element as the transport plays it. One seek is on its way to the screen at a time and
 * the newest one asked for waits its turn: Chromium can present the frame of a paused seek after
 * a later seek has finished, which leaves the earlier frame on screen.
 */
function mediaPlayer(element: HTMLMediaElement): RuntimePlayer {
  let waiting: number | null = null;
  let turn = 0;
  let busy = false;
  function go(seconds: number) {
    const mine = ++turn;
    busy = true;
    const shown = () => {
      if (mine !== turn) return;
      busy = false;
      if (waiting === null) return;
      const next = waiting;
      waiting = null;
      go(next);
    };
    const video = element instanceof HTMLVideoElement;
    if (video) element.requestVideoFrameCallback(shown);
    element.addEventListener(
      "seeked",
      // Sound has no frame to wait for, and a seek within the frame on screen draws none.
      () => (video ? setTimeout(shown, PRESENT_MS) : shown()),
      { once: true },
    );
    element.currentTime = seconds;
  }
  return {
    play: () =>
      void element.play().catch((error: unknown) => {
        // A pause before playback starts rejects the play it interrupted.
        if (!(error instanceof DOMException && error.name === "AbortError"))
          reportEditorError("viewer", error);
      }),
    pause: () => element.pause(),
    seek(seconds) {
      if (busy) waiting = seconds + INSIDE_FRAME;
      else go(seconds + INSIDE_FRAME);
    },
    time: () => waiting ?? element.currentTime,
    clock: () => null,
    playing: () => !element.paused && !element.ended,
    setMuted(muted) {
      element.muted = muted;
    },
  };
}

/** A still has no time of its own, so its playhead runs on the clock. */
function stillPlayer(): RuntimePlayer {
  let at = 0;
  let started: number | null = null;
  const time = () =>
    started === null ? at : at + (performance.now() - started) / 1000;
  return {
    play() {
      started ??= performance.now();
    },
    pause() {
      at = time();
      started = null;
    },
    seek(seconds) {
      at = seconds;
      if (started !== null) started = performance.now();
    },
    time,
    clock: () => null,
    playing: () => started !== null,
    setMuted() {},
  };
}

/** The whole file's waveform, drawn when its peaks arrive and when the viewer resizes. */
function Waveform({
  projectId,
  file,
  version,
}: {
  projectId: string;
  file: MediaDrag;
  version: string | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    // The finest level whose buckets for the whole file arrive in one request.
    const samples =
      peakLevels.find(
        (samples) =>
          (file.seconds * mediaSettings.peakSampleRate) / samples <= PEAK_CHUNK,
      ) ?? peakLevels.at(-1)!;
    const buckets = (file.seconds * mediaSettings.peakSampleRate) / samples;
    const draw = () => {
      const width = Math.round(element.clientWidth * devicePixelRatio);
      const height = Math.round(element.clientHeight * devicePixelRatio);
      const pairs = media.peaks(
        file.path,
        peakLevels.indexOf(samples),
        0,
        true,
      );
      const context = element.getContext("2d");
      if (!width || !height || !pairs || !context) return;
      element.width = width;
      element.height = height;
      context.fillStyle = getComputedStyle(element).color;
      const perPixel = buckets / width;
      for (let x = 0; x < width; x++) {
        const from = Math.floor(x * perPixel);
        const to = Math.max(from + 1, Math.floor((x + 1) * perPixel));
        let low = Infinity;
        let high = -Infinity;
        for (let at = from * 2; at < to * 2 && at + 1 < pairs.length; at += 2) {
          low = Math.min(low, pairs[at]!);
          high = Math.max(high, pairs[at + 1]!);
        }
        if (high < low) break;
        const top = Math.round((height / 2) * (1 - high));
        const bottom = Math.round((height / 2) * (1 - low));
        context.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
    };
    const media = createTimelineMedia(projectId, "index.html", draw, {
      [file.path]: version,
    });
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    return () => {
      observer.disconnect();
      media.dispose();
    };
  }, [projectId, file.path, file.seconds, version]);
  return <canvas ref={canvas} className="edit-source-wave" />;
}

/**
 * The loaded file itself, as a box that drags onto the timeline: a picture or a still fitted to
 * the stage, or a waveform across it. Remounts when the file changes.
 */
function SourceMedia({
  projectId,
  file,
  version,
}: {
  projectId: string;
  file: MediaDrag;
  version: string | null;
}) {
  useEffect(
    () => openSourceMarks(projectId, file.path),
    [projectId, file.path, version],
  );
  const media = useRef<HTMLMediaElement | null>(null);
  const hold = (element: HTMLMediaElement | null) => {
    media.current = element;
  };
  useEffect(() => {
    const element = media.current;
    if (!element) {
      sourcePlayer.attach(stillPlayer());
      return () => sourcePlayer.attach(null);
    }
    const ready = () => {
      // A file replaced since Media measured it plays at its new length.
      if (
        Number.isFinite(element.duration) &&
        element.duration !== file.seconds
      )
        useSource.setState({ file: { ...file, seconds: element.duration } });
      sourcePlayer.attach(mediaPlayer(element));
    };
    if (element.readyState >= element.HAVE_METADATA) ready();
    else element.addEventListener("loadedmetadata", ready, { once: true });
    return () => {
      element.removeEventListener("loadedmetadata", ready);
      sourcePlayer.attach(null);
    };
  }, []);
  /** Width over height, once the file says; a picture fills the stage at that shape. */
  const [shape, setShape] = useState(16 / 9);
  const src = mediaUrl(projectId, file.path, version);
  const name = file.path.split("/").at(-1);
  const failed = () => {
    closeSource();
    showToast(`${name} could not be opened.`);
  };
  const pictured = file.kind === "video" || file.kind === "image";
  return (
    <>
      <div
        className="edit-source-media"
        data-kind={pictured ? file.kind : "audio"}
        style={
          pictured
            ? {
                aspectRatio: shape,
                width: `min(100cqw, calc(100cqh * ${shape}))`,
              }
            : undefined
        }
        draggable
        onDragStart={(event) => {
          const range = sourceRange();
          const chip = event.currentTarget.nextElementSibling;
          if (!range || !chip) return;
          event.dataTransfer.setData(MEDIA_DRAG_TYPE, range.path);
          event.dataTransfer.effectAllowed = "copy";
          // The timeline draws the clip where it will land; the pointer carries only its name.
          event.dataTransfer.setDragImage(chip, 0, 0);
          setMediaDrag(range);
        }}
        onDragEnd={() => setMediaDrag(null)}
        onContextMenu={(event) =>
          openContextMenu(
            event,
            "Source",
            [
              ...edits.map(({ action }) => ({ action })),
              "separator",
              { action: "markIn" },
              { action: "markOut" },
              { action: "markResetInOut" },
              "separator",
              { label: "Close source", run: closeSource },
            ],
            event.currentTarget,
          )
        }
      >
        {file.kind === "image" && (
          <img
            src={src}
            alt=""
            draggable={false}
            onLoad={({ currentTarget: image }) =>
              setShape(image.naturalWidth / image.naturalHeight)
            }
            onError={failed}
          />
        )}
        {file.kind === "video" && (
          <video
            ref={hold}
            src={src}
            preload="auto"
            playsInline
            onLoadedMetadata={({ currentTarget: video }) =>
              setShape(video.videoWidth / video.videoHeight)
            }
            onError={failed}
          />
        )}
        {!pictured && (
          <>
            <audio ref={hold} src={src} preload="auto" onError={failed} />
            <Waveform projectId={projectId} file={file} version={version} />
            <ScrubMarks player={sourcePlayer} />
          </>
        )}
      </div>
      <span className="edit-source-chip" aria-hidden="true">
        {name}
      </span>
    </>
  );
}

/** How much Insert, Overwrite and a drag would place: in to out, or the whole file. */
function PlacedLength() {
  const fps = sourcePlayer.use((state) => state.fps);
  const frames = sourcePlayer.use(
    ({ range, duration }) => (range.out ?? duration) - (range.in ?? 0),
  );
  return (
    <span className="edit-source-length" title="Length to place">
      {formatTimecode(frames, fps)}
    </span>
  );
}

/**
 * One media file over the timeline's picture, played and marked with the transport's own keys.
 * Its picture drags onto the timeline as the marked range. The timeline's preview stays loaded
 * underneath, so switching back shows it at once.
 */
export function SourceViewer({ projectId }: { projectId: string }) {
  const file = useSource((state) => state.file);
  const shown = useSource((state) => state.shown);
  const version = useWorkspace((state) =>
    file ? (state.fileChanges[file.path] ?? null) : null,
  );
  if (!file) return null;
  return (
    <div
      className="edit-source"
      role="group"
      aria-label="Source"
      hidden={!shown}
    >
      <header className="edit-source-head" onClick={blurPointerButton}>
        <span className="edit-source-name" title={file.path}>
          {file.path.split("/").at(-1)}
        </span>
        <PlacedLength />
        <span className="edit-grow" />
        {edits.map(({ mode, label, action }) => (
          <button
            key={mode}
            className="edit-tool"
            title={hint(action)}
            onClick={() => placeSource(projectId, mode)}
          >
            <span>{label}</span>
            <kbd>{keymap[action].keys[0]}</kbd>
          </button>
        ))}
        <button
          className="edit-icon"
          aria-label="Close source"
          title="Close source"
          onClick={closeSource}
        >
          <X size={14} />
        </button>
      </header>
      <div className="edit-source-stage">
        <SourceMedia
          key={`${file.path}:${version}`}
          projectId={projectId}
          file={file}
          version={version}
        />
      </div>
      <ScrubTrack player={sourcePlayer} />
    </div>
  );
}
