import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { runtimeProtocolMetadata } from "@hyperframes/core/runtime/protocol";
import type { EditorMode, EditorReviewDraft } from "../../shared/editor";
import { frameTime } from "../../shared/timeline/apply";
import { ReviewCanvas } from "../components/ReviewCanvas";
import { useWorkspace } from "../workspace";
import { transport, useTransport } from "./transport";
import type { RuntimePlayer } from "./transport";

export type Zoom = "fit" | "actual";

interface Slot {
  gen: number;
  width: number;
  height: number;
}

/** A load that has not produced a player by then has failed; the held frame stays. */
const READY_TIMEOUT = 15_000;

const nextFrame = (win: Window) =>
  new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));

/** The runtime's player in a loaded preview, checked at the frame boundary. */
function runtimeOf(frame: HTMLIFrameElement): RuntimePlayer | null {
  const win = frame.contentWindow;
  if (!win || !("__player" in win)) return null;
  const player = win.__player;
  if (
    typeof player !== "object" ||
    player === null ||
    !("play" in player && typeof player.play === "function") ||
    !("pause" in player && typeof player.pause === "function") ||
    !("seek" in player && typeof player.seek === "function") ||
    !("getTime" in player && typeof player.getTime === "function")
  )
    return null;
  const { play, pause, seek, getTime } = player;
  const post = (action: string, payload: object) => {
    const { fps } = useTransport.getState();
    win.postMessage(
      {
        ...payload,
        source: "hf-parent",
        type: "control",
        action,
        ...runtimeProtocolMetadata(fps.num / fps.den),
      },
      "*",
    );
  };
  return {
    play: () => play.call(player),
    pause: () => pause.call(player),
    seek: (seconds) => seek.call(player, seconds),
    time: () => Number(getTime.call(player)),
    setMuted: (muted) => post("set-muted", { muted }),
  };
}

/** Resolves once the runtime has drawn the frame it was last asked to seek to. */
async function painted(frame: HTMLIFrameElement) {
  const win = frame.contentWindow;
  if (!win) return;
  const wait =
    "__hfWaitForSeekCompletion" in win ? win.__hfWaitForSeekCompletion : null;
  if (typeof wait === "function")
    await Promise.resolve(wait.call(win)).catch(() => {});
  await nextFrame(win);
  await nextFrame(win);
}

function sizeOf(frame: HTMLIFrameElement) {
  const root = frame.contentDocument?.querySelector("[data-composition-id]");
  const read = (name: string, fallback: number) => {
    const value = Number(root?.getAttribute(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { width: read("data-width", 1920), height: read("data-height", 1080) };
}

/**
 * The composition picture. A reload loads the new document under the one on screen, which holds
 * its last frame; the new one takes over at the same frame once it has painted. A failed load
 * leaves the held frame and reports in the status bar.
 */
export function Viewer({
  projectId,
  revision,
  zoom,
  mode,
  onReview,
}: {
  projectId: string;
  /** Changes whenever the composition changes on disk. */
  revision: number;
  zoom: Zoom;
  mode: EditorMode;
  onReview?: (draft: EditorReviewDraft) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const latest = useRef(0);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [live, setLive] = useState<Slot | null>(null);
  const [pending, setPending] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setStageSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    latest.current += 1;
    setPending(latest.current);
  }, [revision]);

  useEffect(
    () => () => {
      transport.attach(null);
      useWorkspace.setState({ editorError: null });
    },
    [],
  );

  const load = async (gen: number, frame: HTMLIFrameElement) => {
    const started = performance.now();
    let player = runtimeOf(frame);
    while (!player) {
      if (performance.now() - started > READY_TIMEOUT)
        throw new Error("The preview did not finish loading.");
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (gen !== latest.current) return;
      player = runtimeOf(frame);
    }
    // Seek until the frame on screen is the latest one asked for.
    let shown = -1;
    while (shown !== useTransport.getState().frame) {
      shown = useTransport.getState().frame;
      player.seek(frameTime(shown, useTransport.getState().fps));
      await painted(frame);
      if (gen !== latest.current) return;
      if (useTransport.getState().state.kind !== "stopped") break;
    }
    setLive({ gen, ...sizeOf(frame) });
    setPending(null);
    transport.attach(player, shown);
    useWorkspace.setState({ editorError: null });
  };

  const fit = live ?? { width: 1920, height: 1080 };
  const scale =
    zoom === "actual"
      ? 1
      : Math.min(
          (stageSize.width - 24) / fit.width,
          (stageSize.height - 24) / fit.height,
        );
  const width = Math.max(0, Math.floor(fit.width * scale));
  const height = Math.max(0, Math.floor(fit.height * scale));
  const armed = mode === "draw" || mode === "comment";
  const slots = [live?.gen, pending].filter(
    (gen): gen is number => gen != null,
  );

  return (
    <div ref={stage} className="edit-stage">
      <div
        className="edit-picture"
        data-armed={armed || undefined}
        data-empty={!live || undefined}
        style={{
          width,
          height,
          left: Math.floor((stageSize.width - width) / 2),
          top: Math.floor((stageSize.height - height) / 2),
        }}
      >
        {slots.map((gen) => {
          const size = gen === live?.gen ? live : fit;
          return (
            <iframe
              key={gen}
              className="edit-frame"
              title="Composition preview"
              tabIndex={-1}
              src={`/api/projects/${encodeURIComponent(projectId)}/preview?v=${gen}`}
              data-live={gen === live?.gen || undefined}
              style={{
                width: size.width,
                height: size.height,
                transform: `scale(${width / size.width}, ${height / size.height})`,
              }}
              onLoad={(event) =>
                void load(gen, event.currentTarget).catch((error: unknown) => {
                  if (gen !== latest.current) return;
                  setPending(null);
                  useWorkspace.setState({
                    editorError:
                      error instanceof Error ? error.message : String(error),
                  });
                })
              }
            />
          );
        })}
        {armed && (
          <ReviewCanvas
            projectId={projectId}
            mode={mode}
            begin={() => {
              transport.dispatch({ type: "stop" });
              const { frame, fps } = useTransport.getState();
              return {
                time: frameTime(frame, fps),
                compositionPath: "index.html",
                elementIds: [],
              };
            }}
            onReview={onReview}
          />
        )}
      </div>
    </div>
  );
}
