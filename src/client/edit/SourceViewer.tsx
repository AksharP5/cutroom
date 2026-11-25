import { canAddVersion } from "../../shared/timeline/versions";
import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { z } from "zod";
import { libraryTitle } from "../../shared/library";
import type { LibraryItem } from "../../shared/library";
import {
  makesProxy,
  mediaSettings,
  needsVideoProxy,
  peakLevels,
} from "../../shared/media";
import { RuntimeStateSchema } from "../../shared/preview";
import { pictureAt } from "../../shared/timeline/piece";
import { pictureSeek } from "../../shared/timeline/pictureSource";
import type { PictureSource } from "../../shared/timeline/pictureSource";
import { formatTimecode } from "../../shared/timeline/timecode";
import { TimecodeText } from "../components/TimecodeText";
import { mediaUrl } from "../api";
import {
  fetchMediaProbe,
  fetchMediaReady,
  fetchPictureSource,
  mediaAssetUrl,
} from "../mediaAsset";
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
import { addClipVersion, versionMediaTarget } from "./versions";
import { useTimeline } from "./timeline";
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
function mediaPlayer(
  element: HTMLMediaElement,
  seekPosition: (seconds: number) => number,
): RuntimePlayer {
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
    element.currentTime = Math.min(seekPosition(seconds), element.duration);
  }
  return {
    play() {
      // The playhead may start playing while a paused seek is still painting.
      if (waiting !== null) {
        const next = waiting;
        waiting = null;
        go(next);
      }
      void element.play().catch((error: unknown) => {
        // A pause before playback starts rejects the play it interrupted.
        if (!(error instanceof DOMException && error.name === "AbortError"))
          reportEditorError("viewer", error);
      });
    },
    pause: () => element.pause(),
    seek(seconds) {
      if (busy) waiting = seconds;
      else go(seconds);
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
  /** Width over height, once the file says; a picture fills the stage at that shape. */
  const [shape, setShape] = useState(16 / 9);
  const [preparing, setPreparing] = useState(false);
  const src = mediaUrl(projectId, file.path, version);
  const name = file.path.split("/").at(-1);
  const failed = () => {
    closeSource();
    showToast(`${name} could not be opened.`);
  };
  useEffect(() => {
    const element = media.current;
    if (!element) {
      sourcePlayer.attach(stillPlayer());
      return () => sourcePlayer.attach(null);
    }
    const controller = new AbortController();
    const { signal } = controller;
    const video = element instanceof HTMLVideoElement ? element : null;
    let proxy = false;
    let pictures: PictureSource | null = null;
    let attached = false;
    const ready = () => {
      // The proxy's stream length can round differently. Marks stay on the source's clock.
      if (
        !proxy &&
        Number.isFinite(element.duration) &&
        element.duration !== file.seconds
      )
        useSource.setState({ file: { ...file, seconds: element.duration } });
      if (video?.videoWidth) setShape(video.videoWidth / video.videoHeight);
      attached = true;
      sourcePlayer.attach(
        mediaPlayer(element, (seconds) => {
          if (!pictures || sourcePlayer.use.getState().state.kind === "playing")
            return seconds + INSIDE_FRAME;
          const ordinal = pictureAt(pictures.index, seconds);
          return ordinal === null
            ? seconds + INSIDE_FRAME
            : Math.max(0, pictureSeek(pictures.index, ordinal));
        }),
      );
    };
    if (element.readyState >= element.HAVE_METADATA) ready();
    else
      element.addEventListener("loadedmetadata", ready, { once: true, signal });

    if (video) {
      const asset = (kind: string) =>
        mediaAssetUrl(projectId, kind, file.path, version);
      const prepare = async () => {
        const probe = await fetchMediaProbe(asset("probe"), signal);
        signal.throwIfAborted();
        if (!probe?.video || !needsVideoProxy(probe.video.codec)) {
          video.src = src;
          return;
        }
        proxy = true;
        setPreparing(true);
        const seconds = probe.duration ?? probe.video.duration;
        if (seconds > 0 && seconds !== file.seconds)
          useSource.setState({ file: { ...file, seconds } });
        void fetchPictureSource(asset("frames"), signal).then((index) => {
          if (!index || signal.aborted) return;
          pictures = index;
          const { state, frame } = sourcePlayer.use.getState();
          if (attached && state.kind === "stopped") sourcePlayer.seek(frame);
        });
        const url = makesProxy(probe.video)
          ? asset(
              video.canPlayType("application/vnd.apple.mpegurl")
                ? "editing-proxy"
                : "proxy",
            )
          : `/api/projects/${encodeURIComponent(projectId)}/isolated-preview?${new URLSearchParams({ source: file.path, v: version ?? "" })}`;
        if (!(await fetchMediaReady(url, signal, 250, "HEAD"))) {
          if (!signal.aborted) failed();
          return;
        }
        if (!signal.aborted) video.src = url;
      };
      void prepare().catch((error: unknown) => {
        if (signal.aborted) return;
        console.warn("Source footage could not be prepared", error);
        failed();
      });
    }
    return () => {
      controller.abort();
      sourcePlayer.attach(null);
    };
  }, []);
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
          <>
            <video
              ref={hold}
              preload="auto"
              playsInline
              onLoadedData={() => setPreparing(false)}
              onError={failed}
            />
            {preparing && (
              <div className="edit-preparing" role="status">
                Preparing footage
              </div>
            )}
          </>
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

/** The runtime's bridge is up: it says so once, then reports its state as it runs. */
const RuntimeReadySchema = z.object({
  source: z.literal("hf-preview"),
  type: z.enum(["ready", "state"]),
});

/**
 * A library item's preview frame as the transport plays it, through the HyperFrames runtime's
 * own control messages. Between the runtime's reports the time runs on the page clock.
 */
function libraryPlayer(
  frame: HTMLIFrameElement,
): RuntimePlayer & { dispose(): void } {
  let at = 0;
  let since: number | null = null;
  const post = (action: string, payload: object = {}) =>
    frame.contentWindow?.postMessage(
      { source: "hf-parent", type: "control", action, ...payload },
      "*",
    );
  // A frame's timestamp can precede the instant playback started, which is no time at all.
  const time = (now = performance.now()) =>
    since === null ? at : at + Math.max(0, now - since) / 1000;
  const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== frame.contentWindow) return;
    const state = RuntimeStateSchema.safeParse(event.data);
    if (!state.success) return;
    at = state.data.currentTime;
    since = state.data.isPlaying ? performance.now() : null;
  };
  window.addEventListener("message", receive);
  return {
    play() {
      since ??= performance.now();
      post("play");
    },
    pause() {
      at = time();
      since = null;
      post("pause");
    },
    seek(seconds) {
      at = seconds;
      if (since !== null) since = performance.now();
      post("seek", { timeSeconds: seconds + INSIDE_FRAME, seekMode: "commit" });
    },
    time: (now) => time(now),
    clock: () => null,
    playing: () => since !== null,
    setMuted: (muted) => post("set-muted", { muted }),
    dispose: () => window.removeEventListener("message", receive),
  };
}

/**
 * A library item playing live from Cutroom's cache, at the project's size, in the same sandbox
 * as project previews. Its picture drags onto the timeline like footage.
 */
function LibrarySource({ item }: { item: LibraryItem }) {
  const size = useTimeline((state) => state.view?.size) ?? {
    width: 1920,
    height: 1080,
  };
  const [src, setSrc] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const title = libraryTitle(item.title);
  // Building the preview can download the item; a failure closes the source with its reason.
  useEffect(() => {
    const closing = new AbortController();
    fetch(
      `/api/cutroom/library/${encodeURIComponent(item.name)}/preview?width=${size.width}&height=${size.height}`,
      { signal: closing.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            z.object({ error: z.string() }).safeParse(await response.json())
              .data?.error ?? `The preview failed (${response.status}).`,
          );
        await response.body?.cancel();
        setSrc(response.url);
      })
      .catch((error: unknown) => {
        if (closing.signal.aborted) return;
        closeSource();
        showToast(
          `${title} could not be opened. ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return () => closing.abort();
  }, [item.name, size.width, size.height, title]);
  // The frame draws at the project's size and scales to the stage.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      element.style.setProperty(
        "--library-scale",
        String(element.clientWidth / size.width),
      ),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [size.width]);
  // The runtime takes control messages once its bridge is up.
  useEffect(() => {
    const element = frame.current;
    if (!src || !element) return;
    const player = libraryPlayer(element);
    let attached = false;
    const ready = (event: MessageEvent<unknown>) => {
      if (
        attached ||
        event.source !== element.contentWindow ||
        !RuntimeReadySchema.safeParse(event.data).success
      )
        return;
      attached = true;
      sourcePlayer.attach(player);
    };
    window.addEventListener("message", ready);
    return () => {
      window.removeEventListener("message", ready);
      sourcePlayer.attach(null);
      player.dispose();
    };
  }, [src]);
  const shape = size.width / size.height;
  return (
    <>
      <div
        ref={box}
        className="edit-source-media library-source"
        data-kind="composition"
        style={{
          aspectRatio: shape,
          width: `min(100cqw, calc(100cqh * ${shape}))`,
        }}
        draggable
        onDragStart={(event) => {
          const range = sourceRange();
          const chip = event.currentTarget.nextElementSibling;
          if (!range || !chip) return;
          event.dataTransfer.setData(MEDIA_DRAG_TYPE, range.path);
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setDragImage(chip, 0, 0);
          setMediaDrag(range);
        }}
        onDragEnd={() => setMediaDrag(null)}
      >
        {src && (
          <iframe
            ref={frame}
            src={src}
            title={title}
            sandbox="allow-scripts"
            tabIndex={-1}
            style={{ width: size.width, height: size.height }}
          />
        )}
      </div>
      <span className="edit-source-chip" aria-hidden="true">
        {title}
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
      <TimecodeText timecode={formatTimecode(frames, fps)} />
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
  const versionClip = useTimeline((state) => {
    const clip = file && versionMediaTarget(state, file.kind);
    return clip && state.view && canAddVersion(clip, state.view.timeline)
      ? clip
      : null;
  });
  const version = useWorkspace((state) =>
    file ? state.fileChanges[file.path] : undefined,
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
          {file.library
            ? libraryTitle(file.library.title)
            : file.path.split("/").at(-1)}
        </span>
        <PlacedLength />
        {file.library && (
          <span className="library-meta" title={file.library.description}>
            {file.library.description}
          </span>
        )}
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
          className="edit-tool"
          hidden={!!file.library}
          disabled={!versionClip || version === null}
          onClick={() => {
            const range = sourceRange();
            if (versionClip && range) addClipVersion(versionClip, range);
          }}
        >
          Add version
        </button>
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
        {/* Gone from this name: a rename gives the file its new path, and a listing without it closes
        the source. Asking for it until then would only fail and close the source. */}
        {file.library ? (
          <LibrarySource key={file.library.name} item={file.library} />
        ) : (
          version !== null && (
            <SourceMedia
              key={`${file.path}:${version}`}
              projectId={projectId}
              file={file}
              version={version ?? null}
            />
          )
        )}
      </div>
      <ScrubTrack player={sourcePlayer} />
    </div>
  );
}
