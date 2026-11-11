import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorMode } from "../../shared/editor";
import type { ReviewItem } from "../../shared/review";
import { frameTime } from "../../shared/timeline/apply";
import { compositionFps, reportEditorError, useWorkspace } from "../workspace";
import { useProjectNotes } from "./noteStore";
import { POPOVER_WIDTH } from "./notes";
import { NoteLayer } from "./NoteLayer";
import type { SaveNote } from "./NoteLayer";
import { transport, useTransport } from "./transport";
import { connectPreview } from "./preview";

export type Zoom = "fit" | "actual";

interface Slot {
  gen: number;
  revision: number;
  width: number;
  height: number;
}

/** A load that has not produced a player by then has failed; the held frame stays. */
const READY_TIMEOUT = 15_000;
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
  notes,
  onOpenNote,
  onSaveNote,
}: {
  projectId: string;
  /** Changes whenever the composition changes on disk. */
  revision: number;
  zoom: Zoom;
  mode: EditorMode;
  notes: readonly ReviewItem[];
  onOpenNote(id: string): void;
  onSaveNote: SaveNote;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const connections = useRef(
    new Map<number, ReturnType<typeof connectPreview>>(),
  );
  const draftId = useProjectNotes(
    (state) => state.projects[projectId]?.draft?.id,
  );
  const drawing = useProjectNotes(
    (state) => !!state.projects[projectId]?.draft?.strokes.length,
  );
  const [roomFor, setRoomFor] = useState<string | null>(null);
  const reserveNote = drawing && roomFor === draftId;
  const latest = useRef(0);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [live, setLive] = useState<Slot | null>(null);
  const [held, setHeld] = useState<Slot[]>([]);
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

  useEffect(() => {
    for (const [gen, connection] of connections.current) {
      if (
        gen === live?.gen ||
        held.some((slot) => slot.gen === gen) ||
        gen === pending
      )
        continue;
      connection.dispose();
      connections.current.delete(gen);
    }
  }, [live?.gen, held, pending]);

  useLayoutEffect(() => {
    if (!live) return;
    const preview = connections.current.get(live.gen);
    if (!preview) return;
    // Warmup painted at 1% opacity. Confirm a paint after the DOM promotes this
    // iframe, then let the parent paint before retiring older documents.
    void (async () => {
      try {
        await preview.painted();
        if (preview.signal.aborted) return;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (preview.signal.aborted) return;
        setHeld((held) =>
          held.some((slot) => slot.gen < live.gen)
            ? held.filter((slot) => slot.gen >= live.gen)
            : held,
        );
      } catch (error) {
        if (!preview.signal.aborted) reportEditorError("viewer", error);
      }
    })();
  }, [live]);

  useEffect(
    () => () => {
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
    const started = performance.now();
    const preview = connectPreview(frame);
    connections.current.get(gen)?.dispose();
    connections.current.set(gen, preview);
    try {
      await preview.inspect();
      while (!preview.state.ready) {
        if (preview.state.error)
          throw new Error(
            `The preview failed to start: ${preview.state.error}`,
          );
        if (performance.now() - started > READY_TIMEOUT)
          throw new Error("The preview did not finish loading.");
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
      const { width, height, fps } = preview.state;
      const size = { width, height };
      setHeld((held) =>
        live && live.gen !== gen && !held.some((slot) => slot.gen === live.gen)
          ? [...held, live]
          : held,
      );
      setLive({ gen, revision, ...size });
      setPending(null);
      // The status bar shows the open composition's rate and size, as with the embedded editor.
      useWorkspace.setState({
        composition: {
          fps: compositionFps(fps),
          ...size,
        },
      });
      transport.attach(player, shown);
      reportEditorError("viewer", null);
    } catch (error) {
      if (preview.signal.aborted || gen !== latest.current) return;
      preview.dispose();
      connections.current.delete(gen);
      setPending(null);
      reportEditorError("viewer", error);
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
  const slots = [...held.map((slot) => slot.gen), live?.gen, pending].filter(
    (gen): gen is number => gen != null,
  );

  return (
    <div
      ref={stage}
      className="edit-stage"
      data-preview-ready={
        pending === null && live?.revision === revision && held.length === 0
          ? live.revision
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
          const retained = held.find((slot) => slot.gen === gen);
          const size = retained ?? (gen === live?.gen ? live : fit);
          return (
            <iframe
              key={gen}
              className="edit-frame"
              title="Composition preview"
              tabIndex={-1}
              sandbox="allow-scripts"
              allow="autoplay"
              src={`/api/projects/${encodeURIComponent(projectId)}/isolated-preview?v=${gen}`}
              data-live={gen === live?.gen || undefined}
              data-held={Boolean(retained) || undefined}
              style={{
                width: size.width,
                height: size.height,
                transform: `scale(${width / size.width}, ${height / size.height})`,
              }}
              onLoad={(event) => void load(gen, event.currentTarget)}
            />
          );
        })}
      </div>
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
