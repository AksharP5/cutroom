import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { EditorMode } from "../../shared/editor";
import type { ReviewItem } from "../../shared/review";
import { frameTime } from "../../shared/timeline/apply";
import {
  compositionFps,
  reportEditorError,
  showToast,
  useWorkspace,
} from "../workspace";
import { useProjectNotes } from "./noteStore";
import { POPOVER_WIDTH } from "./notes";
import { NoteLayer } from "./NoteLayer";
import { PictureSelect } from "./PictureSelect";
import { useTimeline } from "./timeline";
import { emptySelection } from "../timeline/selection";
import type { SaveNote } from "./NoteLayer";
import { transport, useTransport } from "./transport";
import { connectPreview } from "./preview";
import { previewRefresh } from "./previewRefresh";
import { transitionHandoff } from "./viewerHandoff";
import { editPicture, followEditPicture } from "./editFrame";

export type Zoom = "fit" | "actual";

/** Includes navigation, preparation, and the first fully visible paint. */
const READY_TIMEOUT = 15_000;
/**
 * Warm one candidate over the last confirmed picture. Only a visible paint can
 * confirm its replacement; a failed or superseded candidate is retired.
 */
export function Viewer({
  projectId,
  change,
  zoom,
  mode,
  notes,
  onOpenNote,
  onSaveNote,
}: {
  projectId: string;
  /** The preview watcher owns invalidation, including edits from other tabs and disk. */
  change: { revision: number; path: string };
  zoom: Zoom;
  mode: EditorMode;
  notes: readonly ReviewItem[];
  onOpenNote(id: string): void;
  onSaveNote: SaveNote;
}) {
  const documentId = useRef(crypto.randomUUID());
  const { revision } = change;
  const stage = useRef<HTMLDivElement>(null);
  const editLabels = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const show = () => {
      const element = editLabels.current;
      if (!element) return;
      const labels = editPicture()?.labels ?? [];
      element.hidden = labels.length !== 2;
      element.querySelectorAll("span").forEach((child, index) => {
        child.textContent = (labels[index] ?? "").replace(" ", "\n");
      });
    };
    show();
    return followEditPicture(show);
  }, []);
  const connections = useRef(
    new Map<number, ReturnType<typeof connectPreview>>(),
  );
  const draftId = useProjectNotes(
    (state) => state.projects[projectId]?.draft?.id,
  );
  const drawing = useProjectNotes(
    (state) => !!state.projects[projectId]?.draft?.strokes.length,
  );
  const attached = useRef<ReturnType<typeof connectPreview> | null>(null);
  const [roomFor, setRoomFor] = useState<string | null>(null);
  const reserveNote = drawing && roomFor === draftId;
  const latest = useRef(0);
  const loadingRevision = useRef<{ gen: number; revision: number } | null>(
    null,
  );
  const dismissFailure = useRef<(() => void) | undefined>(undefined);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [handoff, transition] = useReducer(transitionHandoff, {
    kind: "showing",
    confirmed: null,
  });
  const candidate =
    handoff.kind === "loading" || handoff.kind === "promoting"
      ? handoff.candidate
      : null;
  const live =
    handoff.kind === "promoting" ? handoff.candidate : handoff.confirmed;

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

  const shownHandoff = useRef(handoff);
  const settled = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    shownHandoff.current = handoff;
    if (handoff.kind === "showing" || handoff.kind === "failed") {
      settled.current?.();
      settled.current = null;
    }
  }, [handoff]);
  const waitForPicture = () =>
    new Promise<void>((resolve) => {
      if (
        shownHandoff.current.kind === "showing" ||
        shownHandoff.current.kind === "failed"
      )
        resolve();
      else settled.current = resolve;
    });
  const refresh = useRef<ReturnType<
    typeof previewRefresh<typeof change>
  > | null>(null);
  useLayoutEffect(() => {
    const closing = new AbortController();
    refresh.current = previewRefresh(
      async (change, isLatest) => {
        await waitForPicture();
        if (closing.signal.aborted) return;
        const readyDeadline = performance.now() + READY_TIMEOUT;
        const state = shownHandoff.current;
        const picture = state.kind === "showing" ? state.confirmed : null;
        const preview = picture && connections.current.get(picture.gen);
        if (
          picture &&
          preview?.timingAllowed &&
          change.path === "index.html" &&
          useTransport.getState().state.kind === "stopped" &&
          !editPicture()
        ) {
          const attempt = new AbortController();
          const signal = AbortSignal.any([closing.signal, attempt.signal]);
          const timer = window.setTimeout(() => attempt.abort(), 2000);
          const stop = useTransport.subscribe((state, previous) => {
            if (
              state.state.kind !== "stopped" ||
              state.frame !== previous.frame
            )
              attempt.abort();
          });
          try {
            const { frame, fps } = useTransport.getState();
            if (
              await preview.updateTiming(
                frameTime(frame, fps),
                signal,
                isLatest,
              )
            )
              transition({
                type: "updated",
                gen: picture.gen,
                revision: change.revision,
              });
            return;
          } catch {
            if (closing.signal.aborted || !isLatest()) return;
          } finally {
            clearTimeout(timer);
            stop();
          }
        }
        if (!isLatest() || closing.signal.aborted) return;
        latest.current += 1;
        loadingRevision.current = {
          gen: latest.current,
          revision: change.revision,
        };
        transition({
          type: "navigate",
          gen: latest.current,
          deadline: readyDeadline,
        });
        // A newer invalidation waits here, replacing the pending destination rather
        // than retiring every candidate before it can paint.
        await new Promise<void>((resolve) => {
          settled.current = resolve;
        });
      },
      (reason) => reportEditorError("viewer", reason),
    );
    latest.current += 1;
    loadingRevision.current = { gen: latest.current, revision: 0 };
    transition({
      type: "navigate",
      gen: latest.current,
      deadline: performance.now() + READY_TIMEOUT,
    });
    return () => {
      closing.abort();
      refresh.current?.dispose();
      settled.current?.();
      settled.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (change.revision) refresh.current?.push(change);
  }, [change]);

  useLayoutEffect(() => {
    for (const [gen, connection] of connections.current) {
      if (gen === handoff.confirmed?.gen || gen === candidate?.gen) continue;
      connection.dispose();
      connections.current.delete(gen);
    }
  }, [handoff.confirmed, candidate]);

  useLayoutEffect(() => {
    if (live) connections.current.get(live.gen)?.present();
  }, [live]);

  useEffect(() => {
    if (!candidate) return;
    const timer = window.setTimeout(
      () => {
        transition({
          type: "failed",
          gen: candidate.gen,
          reason: new Error(
            "The preview did not finish loading or drawing in time.",
          ),
        });
      },
      Math.max(0, candidate.deadline - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [candidate?.gen, candidate?.deadline]);

  useEffect(() => {
    if (handoff.kind !== "failed") return;
    reportEditorError("viewer", handoff.reason);
    dismissFailure.current?.();
    dismissFailure.current = showToast(
      handoff.reason instanceof Error
        ? handoff.reason.message
        : String(handoff.reason),
      undefined,
      { priority: "background" },
    );
    transition({ type: "reported" });
  }, [handoff]);

  const reloading = !!candidate && candidate.gen === handoff.confirmed?.gen;
  useLayoutEffect(() => {
    if (reloading) transport.suspend();
  }, [reloading]);

  useLayoutEffect(() => {
    if (handoff.kind !== "promoting") return;
    const { candidate } = handoff;
    const preview = connections.current.get(candidate.gen);
    if (!preview) return;
    // Warmup painted at 1% opacity. Confirm the fully visible document, then
    // let the parent paint before retiring the last confirmed picture.
    void (async () => {
      await preview.painted();
      preview.signal.throwIfAborted();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      preview.signal.throwIfAborted();
      transition({ type: "painted", gen: candidate.gen });
    })().catch((reason: unknown) => {
      if (!preview.signal.aborted)
        transition({ type: "failed", gen: candidate.gen, reason });
    });
  }, [handoff]);

  useLayoutEffect(() => {
    const picture = handoff.confirmed;
    if (!picture) return;
    const preview = connections.current.get(picture.gen);
    if (!preview) return;
    if (loadingRevision.current?.gen === picture.gen)
      loadingRevision.current = null;
    useWorkspace.setState({
      composition: {
        fps: compositionFps(preview.state.fps),
        width: picture.width,
        height: picture.height,
      },
    });
    if (attached.current !== preview) {
      transport.attach(preview.player, picture.shown);
      attached.current = preview;
    }
    reportEditorError("viewer", null);
    dismissFailure.current?.();
    dismissFailure.current = undefined;
  }, [handoff.confirmed]);

  useEffect(
    () => () => {
      dismissFailure.current?.();
      for (const connection of connections.current.values())
        connection.dispose();
      connections.current.clear();
      transport.attach(null);
      reportEditorError("viewer", null);
      useWorkspace.setState({ composition: null });
    },
    [],
  );

  const load = async (gen: number, frame: HTMLIFrameElement) => {
    if (gen !== latest.current || !frame.isConnected) return;
    const preview = connectPreview(frame, () => {
      transition({
        type: "unloaded",
        gen,
        deadline: performance.now() + READY_TIMEOUT,
      });
    });
    const reloaded = connections.current.has(gen);
    connections.current.get(gen)?.dispose();
    connections.current.set(gen, preview);
    try {
      if (!reloaded) await preview.authorizeTiming().catch(() => {});
      await preview.inspect();
      while (!preview.state.ready || preview.state.error) {
        if (preview.state.error)
          throw new Error(
            `The preview failed to start: ${preview.state.error}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
        preview.signal.throwIfAborted();
        if (gen !== latest.current) return;
        await preview.inspect();
      }
      if (!preview.state.root)
        throw new Error("The preview has no element with data-composition-id.");
      const { player } = preview;
      // Seek until the frame on screen is the latest one asked for.
      let shown = -1;
      while (shown !== useTransport.getState().frame) {
        shown = useTransport.getState().frame;
        player.seek(frameTime(shown, useTransport.getState().fps));
        await preview.painted();
        preview.signal.throwIfAborted();
        if (gen !== latest.current) return;
        if (useTransport.getState().state.kind !== "stopped") break;
      }
      await preview.activate();
      preview.signal.throwIfAborted();
      if (gen !== latest.current) return;
      const { width, height } = preview.state;
      transition({
        type: "prepared",
        picture: {
          gen,
          revision:
            loadingRevision.current?.gen === gen
              ? loadingRevision.current.revision
              : (shownHandoff.current.confirmed?.revision ?? 0),
          width,
          height,
          shown,
        },
      });
    } catch (reason) {
      if (preview.signal.aborted || gen !== latest.current) return;
      transition({ type: "failed", gen, reason });
    }
  };

  const fit = live ?? { width: 1920, height: 1080 };
  const scale =
    zoom === "actual" && !reserveNote
      ? 1
      : Math.min(
          (stageSize.width - (reserveNote ? POPOVER_WIDTH + 48 : 24)) /
            fit.width,
          (stageSize.height - 24) / fit.height,
        );
  const width = Math.max(0, Math.floor(fit.width * scale));
  const height = Math.max(0, Math.floor(fit.height * scale));
  const box = {
    width,
    height,
    left: reserveNote ? 12 : Math.floor((stageSize.width - width) / 2),
    top: Math.floor((stageSize.height - height) / 2),
  };
  const armed = mode === "draw" || mode === "comment";
  const slots = [...new Set([handoff.confirmed?.gen, candidate?.gen])].filter(
    (gen): gen is number => gen != null,
  );

  return (
    <div
      ref={stage}
      className="edit-stage"
      data-handoff={handoff.kind}
      // A press on the stage around the picture selects nothing.
      onPointerDown={(event) => {
        if (
          mode === "select" &&
          event.button === 0 &&
          event.target === event.currentTarget
        )
          useTimeline.setState({ selection: emptySelection });
      }}
      data-preview-ready={
        handoff.kind === "showing" && handoff.confirmed?.revision === revision
          ? revision
          : undefined
      }
    >
      <div
        className="edit-picture"
        data-armed={armed || undefined}
        data-empty={!live || undefined}
        style={box}
      >
        {slots.map((gen) => {
          const retained =
            handoff.kind === "promoting" &&
            gen === handoff.confirmed?.gen &&
            gen !== candidate?.gen;
          const size = gen === handoff.confirmed?.gen ? handoff.confirmed : fit;
          return (
            <iframe
              key={gen}
              className="edit-frame"
              title="Composition preview"
              tabIndex={-1}
              sandbox="allow-scripts"
              allow="autoplay"
              src={`/api/projects/${encodeURIComponent(projectId)}/isolated-preview?v=${gen}&document=${documentId.current}-${gen}`}
              data-live={gen === live?.gen || undefined}
              data-held={Boolean(retained) || undefined}
              style={{
                width: size.width,
                height: size.height,
                transform: `scale(${width / size.width}, ${height / size.height})`,
              }}
              onLoad={(event) => {
                transition({
                  type: "loaded",
                  gen,
                  deadline: performance.now() + READY_TIMEOUT,
                });
                void load(gen, event.currentTarget);
              }}
            />
          );
        })}
        <div ref={editLabels} className="edit-edge-labels" hidden>
          <div>
            <span />
          </div>
          <div>
            <span />
          </div>
        </div>
      </div>
      {live && width > 0 && (
        <PictureSelect
          projectId={projectId}
          box={box}
          frame={live}
          scale={{ x: width / live.width, y: height / live.height }}
          active={mode === "select"}
        />
      )}
      <NoteLayer
        projectId={projectId}
        stageSize={stageSize}
        onNeedsRoom={() => {
          if (draftId) setRoomFor(draftId);
        }}
        box={box}
        mode={mode}
        notes={notes}
        onOpenNote={onOpenNote}
        onSave={onSaveNote}
      />
    </div>
  );
}
