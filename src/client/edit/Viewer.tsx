import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { TrackGainPreviewSchema } from "../../shared/preview";
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
import { ROOT_COMPOSITION, useTimeline } from "./timeline";
import { emptySelection } from "../timeline/selection";
import type { SaveNote } from "./NoteLayer";
import { transport, useTransport } from "./transport";
import { connectPreview } from "./preview";
import { previewRefresh } from "./previewRefresh";
import { transitionHandoff } from "./viewerHandoff";
import { editPicture, followEditPicture } from "./editFrame";
import { usePipeline } from "../pipeline/setting";

export type Zoom = "fit" | "actual";

/** Includes live verification, navigation, preparation, and the first fully visible paint. */
const READY_TIMEOUT = 15_000;
/**
 * Warm one candidate over the last confirmed picture. Only a visible paint can
 * confirm its replacement; a failed or superseded candidate is retired.
 */
export function Viewer({
  projectId,
  composition,
  change,
  zoom,
  mode,
  notes,
  onOpenNote,
  onSaveNote,
}: {
  projectId: string;
  /** The composition to show: the project's root, or a sub-composition opened from it. */
  composition: string;
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
  // The footage pipeline draws the videos beneath the preview while it is active.
  const pipelineCanvas = useRef<HTMLCanvasElement>(null);
  const pipelineEnabled = usePipeline((state) => state.enabled);
  const pipelineActive = usePipeline((state) => state.active);
  useEffect(() => {
    const canvas = pipelineCanvas.current;
    if (!pipelineEnabled || !canvas) return;
    // Loaded only once the setting is on.
    let detach: (() => void) | null = null;
    let gone = false;
    void import("../pipeline/pipeline").then(({ attachPipeline }) => {
      if (!gone) detach = attachPipeline(projectId, canvas);
    });
    return () => {
      gone = true;
      detach?.();
    };
  }, [projectId, pipelineEnabled]);
  useEffect(() => {
    for (const connection of connections.current.values())
      connection.pipeline(pipelineActive);
  }, [pipelineActive]);
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
  const [mixedRevision, setMixedRevision] = useState<number | null>(null);
  const checking = useRef<AbortController | null>(null);
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
  const timingEligible = useRef(false);
  const [timingReady, setTimingReady] = useState<number | null>(null);
  const settled = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    shownHandoff.current = handoff;
    if (
      handoff.kind === "showing" ||
      handoff.kind === "checking" ||
      handoff.kind === "failed"
    ) {
      settled.current?.();
      settled.current = null;
    }
  }, [handoff]);
  const waitForPicture = () =>
    new Promise<void>((resolve) => {
      if (
        shownHandoff.current.kind === "showing" ||
        shownHandoff.current.kind === "checking" ||
        shownHandoff.current.kind === "failed"
      )
        resolve();
      else settled.current = resolve;
    });
  /**
   * Documents from before the playhead's last move with an edit, and the frame each keeps.
   * Any other frame of a document that predates the edit can be the wrong picture.
   */
  const pins = useRef(new Map<number, number>());
  const frameFor = (gen: number) =>
    pins.current.get(gen) ?? useTransport.getState().frame;
  useEffect(
    () =>
      useTransport.subscribe((state, previous) => {
        if (!state.held) return pins.current.clear();
        if (
          state.held !== "saving" ||
          (previous.held === "saving" && state.frame === previous.frame)
        )
          return;
        const first = shownHandoff.current.confirmed?.gen ?? 1;
        for (let gen = first; gen <= latest.current; gen++)
          if (!pins.current.has(gen)) pins.current.set(gen, previous.frame);
      }),
    [],
  );
  /** Until the server has an edit that moved the playhead, the preview read can predate it. */
  const editSaved = () =>
    new Promise<void>((resolve) => {
      if (useTransport.getState().held !== "saving") return resolve();
      const stop = useTransport.subscribe(({ held }) => {
        if (held === "saving") return;
        stop();
        resolve();
      });
    });
  const refresh = useRef<ReturnType<
    typeof previewRefresh<typeof change>
  > | null>(null);
  /** The composition each document shows, fixed when it is requested. */
  const shownComposition = useRef(composition);
  shownComposition.current = composition;
  const documentCompositions = useRef(new Map<number, string>());
  const previewQuery = (gen: number) => {
    const shown = documentCompositions.current.get(gen) ?? ROOT_COMPOSITION;
    return shown === ROOT_COMPOSITION
      ? ""
      : `&composition=${encodeURIComponent(shown)}`;
  };
  const reload = (
    revision: number,
    deadline = performance.now() + READY_TIMEOUT,
  ) => {
    latest.current += 1;
    documentCompositions.current.set(latest.current, shownComposition.current);
    loadingRevision.current = { gen: latest.current, revision };
    transition({ type: "navigate", gen: latest.current, deadline });
  };
  useLayoutEffect(() => {
    const closing = new AbortController();
    refresh.current = previewRefresh(
      async (change, isLatest) => {
        await editSaved();
        if (
          timingEligible.current &&
          useTransport.getState().state.kind === "stopped"
        )
          await waitForPicture();
        if (closing.signal.aborted || !isLatest()) return;
        const readyDeadline = performance.now() + READY_TIMEOUT;
        const state = shownHandoff.current;
        const picture =
          state.kind !== "loading" && state.kind !== "promoting"
            ? state.confirmed
            : null;
        const preview = picture && connections.current.get(picture.gen);
        const attempt = new AbortController();
        checking.current = attempt;
        const signal = AbortSignal.any([closing.signal, attempt.signal]);
        const timer = window.setTimeout(
          () => {
            transition({
              type: "check-failed",
              revision: change.revision,
              reason: new Error(
                "The preview did not finish loading or drawing in time.",
              ),
            });
            attempt.abort();
          },
          Math.max(0, readyDeadline - performance.now()),
        );
        if (picture)
          transition({
            type: "check",
            revision: change.revision,
            deadline: readyDeadline,
          });
        try {
          if (
            picture &&
            preview?.timingAllowed &&
            change.path === ROOT_COMPOSITION &&
            documentCompositions.current.get(picture.gen) ===
              ROOT_COMPOSITION &&
            useTransport.getState().state.kind === "stopped" &&
            !editPicture()
          ) {
            const timing = new AbortController();
            const timingSignal = AbortSignal.any([signal, timing.signal]);
            const timingTimer = window.setTimeout(() => timing.abort(), 2000);
            const stop = useTransport.subscribe((state, previous) => {
              if (
                state.state.kind !== "stopped" ||
                state.frame !== previous.frame
              )
                timing.abort();
            });
            try {
              const { frame, fps } = useTransport.getState();
              if (
                await preview.updateTiming(
                  frameTime(frame, fps),
                  timingSignal,
                  isLatest,
                  () => {
                    // A newer edit waits for an update the page has started. Abandoning
                    // it would let the page finish it while refusing the next one.
                    if (checking.current === attempt) checking.current = null;
                  },
                )
              ) {
                // The update drew the playhead's frame, so this document is current.
                pins.current.delete(picture.gen);
                transition({
                  type: "updated",
                  gen: picture.gen,
                  revision: change.revision,
                });
              }
              return;
            } catch (reason) {
              console.debug("Preview timing fell back to reload:", reason);
              if (!preview.timingAllowed) {
                timingEligible.current = false;
                setTimingReady(null);
              }
              if (signal.aborted || !isLatest()) return;
            } finally {
              clearTimeout(timingTimer);
              stop();
              // Only the page's update runs to its end. A newer edit still aborts the
              // reload or gain check this attempt falls back to.
              checking.current ??= attempt;
            }
          }
          if (
            preview &&
            (/\.html?$/i.test(change.path) || change.path === "cutroom.json")
          ) {
            try {
              const response = await fetch(
                `/api/projects/${encodeURIComponent(projectId)}/isolated-preview?cutroom-mix=1&v=${change.revision}${previewQuery(picture.gen)}`,
                { signal: AbortSignal.any([signal, preview.signal]) },
              );
              if (!response.ok)
                throw new Error(
                  `The preview could not be updated (HTTP ${response.status}).`,
                );
              const snapshot = TrackGainPreviewSchema.parse(
                await response.json(),
              );
              if (signal.aborted || !isLatest()) return;
              if (await preview.mix(snapshot, signal)) {
                if (signal.aborted || !isLatest()) return;
                setMixedRevision(change.revision);
                transition({ type: "mixed", revision: change.revision });
                reportEditorError("viewer", null);
                dismissFailure.current?.();
                dismissFailure.current = undefined;
                return;
              }
            } catch (reason) {
              if (!signal.aborted && isLatest())
                transition({
                  type: "check-failed",
                  revision: change.revision,
                  reason,
                });
              return;
            }
          }
          // A document requested now must come from after the edit.
          await editSaved();
          if (!isLatest() || signal.aborted) return;
          reload(change.revision, readyDeadline);
        } finally {
          clearTimeout(timer);
          if (checking.current === attempt) checking.current = null;
        }
        if (
          !timingEligible.current ||
          useTransport.getState().state.kind !== "stopped"
        )
          return;
        // A newer invalidation waits here, replacing the pending destination rather
        // than retiring every candidate before it can paint.
        await new Promise<void>((resolve) => {
          settled.current = resolve;
        });
      },
      (reason) => reportEditorError("viewer", reason),
    );
    reload(0);
    return () => {
      closing.abort();
      checking.current?.abort();
      refresh.current?.dispose();
      settled.current?.();
      settled.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!change.revision) return;
    checking.current?.abort();
    refresh.current?.push(change);
  }, [change]);
  // Opening a composition loads its document over the last picture, as an edit's reload does.
  const opened = useRef(composition);
  useLayoutEffect(() => {
    if (opened.current === composition) return;
    opened.current = composition;
    checking.current?.abort();
    reload(change.revision);
  }, [composition]);

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

  // A promoted candidate covers the retained picture before it owns playback, so it must
  // draw each frame the playhead is parked on, unless it predates an edit that moved the
  // playhead. The retained document keeps the transport, and with it the sound, until the
  // candidate is confirmed: it can still fail or be replaced.
  useLayoutEffect(() => {
    if (handoff.kind !== "promoting") return;
    const { gen, shown } = handoff.candidate;
    const { player } = connections.current.get(gen) ?? {};
    if (!player) return;
    const show = () =>
      player.seek(frameTime(frameFor(gen), useTransport.getState().fps));
    if (
      useTransport.getState().state.kind !== "playing" &&
      frameFor(gen) !== shown
    )
      show();
    return useTransport.subscribe((state, previous) => {
      if (state.state.kind === "playing" || pins.current.has(gen)) return;
      if (state.frame !== previous.frame || previous.state.kind === "playing")
        show();
    });
  }, [handoff]);

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
    const gen = handoff.retiring;
    if (gen === undefined) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => transition({ type: "retired", gen }));
    });
    return () => cancelAnimationFrame(frame);
  }, [handoff.retiring]);

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
      await preview.inspect();
      if (usePipeline.getState().active) preview.pipeline(true);
      const resume = () => {
        settled.current?.();
        settled.current = null;
      };
      if (!reloaded && preview.hasTimingHint) {
        // A bridge hint can start authorization, never grant it. Painting does not wait.
        void preview
          .authorizeTiming()
          .then(() => {
            if (gen !== latest.current || preview.signal.aborted) return;
            timingEligible.current = preview.timingAllowed;
            setTimingReady(preview.timingAllowed ? gen : null);
            if (!timingEligible.current) resume();
          })
          .catch(() => {
            if (gen === latest.current) {
              timingEligible.current = false;
              setTimingReady(null);
              resume();
            }
          });
      } else {
        timingEligible.current = false;
        setTimingReady(null);
        resume();
      }
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
      let shown = -1;
      /** Seeks until the frame painted is the latest one asked for. False once superseded. */
      const showLatest = async () => {
        while (shown !== frameFor(gen)) {
          shown = frameFor(gen);
          player.seek(frameTime(shown, useTransport.getState().fps));
          await preview.painted();
          preview.signal.throwIfAborted();
          if (gen !== latest.current) return false;
          if (useTransport.getState().state.kind !== "stopped") break;
        }
        return true;
      };
      if (!(await showLatest())) return;
      await preview.activate();
      preview.signal.throwIfAborted();
      if (gen !== latest.current) return;
      // Activation waits for a paint, and a parked playhead can be moved meanwhile.
      if (
        useTransport.getState().state.kind === "stopped" &&
        !(await showLatest())
      )
        return;
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
  // The next candidate mounts once a dropped one has left: never more than two documents.
  const slots = [
    ...new Set([handoff.confirmed?.gen, handoff.retiring ?? candidate?.gen]),
  ].filter((gen): gen is number => gen != null);

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
      data-preview-timing-ready={timingReady === live?.gen || undefined}
      data-pipeline={
        pipelineEnabled ? (pipelineActive ? "on" : "off") : undefined
      }
      data-preview-ready={
        handoff.kind === "showing" &&
        (handoff.confirmed?.revision === revision || mixedRevision === revision)
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
        <canvas
          ref={pipelineCanvas}
          className="edit-pipeline"
          hidden={!pipelineActive}
        />
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
              src={`/api/projects/${encodeURIComponent(projectId)}/isolated-preview?v=${gen}&document=${documentId.current}-${gen}${previewQuery(gen)}`}
              data-live={gen === live?.gen || undefined}
              data-held={Boolean(retained) || undefined}
              data-retiring={gen === handoff.retiring || undefined}
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
