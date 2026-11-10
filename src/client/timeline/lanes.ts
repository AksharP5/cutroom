import { audioGainToText } from "@hyperframes/core/audio-gain";
import { fadePath, gainHeight } from "./mix";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { DragEvent, PointerEvent, RefObject } from "react";
import type { CommandInput, Timeline } from "../../shared/timeline/schema";
import { newTrack, nextTrackIndex } from "../../shared/timeline/tracks";
import { formatTimecode } from "../edit/timecode";
import { anchorsChanged, editAnchors } from "../edit/anchors";
import type { Bodies } from "./bodies";
import {
  SNAP_PX,
  beginDrag,
  bladePreview,
  dragPreview,
  dropPreview,
  idle,
  intentAt,
  previewCommands,
  snapTargets,
  step,
} from "./gesture";
import type { Drag, Gesture, Hit, Outcome, Preview, Tool } from "./gesture";
import { clipsByTrack, rowsBetween } from "./math";
import type { Row, TrackClips } from "./math";
import { MEDIA_DRAG_TYPE, mediaDrag } from "./mediaDrag";
import { slideClips } from "./motion";
import type { Offset } from "./motion";
import { clickSelection, emptySelection, marqueeSelection } from "./selection";
import type { Selection } from "./selection";
import type { TimelineViewport } from "./view";

export interface LaneGestureOptions {
  timeline: Timeline;
  rows: readonly Row[];
  /** The timeline's clips by track, as the canvas draws them outside a drag. */
  tracks: ReadonlyMap<number, TrackClips>;
  selection: Selection;
  tool: Tool;
  snapping: boolean;
  lanes: RefObject<HTMLDivElement | null>;
  viewport: RefObject<TimelineViewport | null>;
  bodies: RefObject<Bodies | null>;
  playhead(): number;
  onSelect(selection: Selection): void;
  /** Makes one undo step; false when the editor refused it and nothing changed. */
  onEdit(label: string, commands: CommandInput[], basis?: Timeline): boolean;
  /** A press began or ended. While one is under way, Esc cancels it and does nothing else. */
  onGesture(active: boolean): void;
}

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/**
 * Every pointer gesture on the lanes: moving, trimming, rolling and razoring clips, the marquee,
 * and media dropped from the Media panel. While a drag goes on, the clips ride transforms to
 * where the engine would put them and the canvas draws that timeline; nothing reaches React or
 * the server until the release, which sends the edit as one undo step.
 */
export function useLaneGestures(options: LaneGestureOptions) {
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef<Gesture>(idle);
  const drag = useRef<Drag | null>(null);
  const originY = useRef(0);
  const preview = useRef<Preview | null>(null);
  /** Where the pointer last was on screen, so a scroll or zoom under it redraws the drag. */
  const pointer = useRef({ x: 0, y: 0, bypass: false });
  /** What the last drawn preview was made from; the same input draws nothing again. */
  const drawn = useRef("");
  const marqueeBase = useRef<Selection>(emptySelection);
  /** A pressed clip that was already selected with others: a click without a drag selects it alone. */
  const kept = useRef<string | null>(null);
  /** Transforms as last written, so an unchanged clip is not restyled. */
  const written = useRef(new WeakMap<Element, string>());
  /** How far each clip is held from its layout. */
  const placed = useRef<ReadonlyMap<string, Offset>>(new Map());
  /** The offsets a committed drag left its clips at, for `useClipMotion`. */
  const held = useRef<ReadonlyMap<string, Offset> | null>(null);
  /** Snap targets for the blade's hover, made again when the timeline or playhead changes. */
  const hoverTargets = useRef<{
    timeline: Timeline;
    playhead: number;
    frames: number[];
  } | null>(null);
  const snapLine = useRef<HTMLElement>(null);
  const bladeLine = useRef<HTMLElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLDivElement>(null);
  const marquee = useRef<HTMLDivElement>(null);
  const pieces = useRef<HTMLDivElement>(null);

  const view = () => latest.current.viewport.current?.state();
  const frameAt = (clientX: number) =>
    latest.current.viewport.current?.frameAtClient(clientX) ?? 0;
  const local = (clientX: number, clientY: number) => {
    const box = latest.current.lanes.current?.getBoundingClientRect();
    return { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) };
  };
  const rowAt = (clientY: number) => {
    const { y } = local(0, clientY);
    return rowsBetween(latest.current.rows, y, y + 1)[0];
  };
  const rowOf = (track: number | undefined) =>
    latest.current.rows.find((row) => row.track.index === track);
  /** Frames within which edges snap: none with snapping off or the bypass key held. */
  const reach = (bypass: boolean) => {
    const ppf = view()?.ppf;
    return latest.current.snapping && !bypass && ppf ? SNAP_PX / ppf : 0;
  };

  /** Puts a mark at a frame, on a row when it belongs to one, or hides it. */
  function mark(element: HTMLElement | null, frame: number | null, row?: Row) {
    if (!element) return;
    element.hidden = frame === null;
    if (frame === null) return;
    const x = Math.round(frame * (view()?.ppf ?? 0));
    element.style.transform = `translate(${x}px, ${row?.top ?? 0}px)`;
    if (row) element.dataset.track = row.track.kind;
  }

  /**
   * Holds the mounted clips where `shown` puts them: a transform on each box, name and outline
   * that `base` lays out elsewhere, and the canvas drawn from `shown`. A clip whose length
   * changed is scaled, its name left unscaled.
   */
  function place(
    base: Timeline,
    shown: Timeline,
    cut: Preview["pieces"] = new Map(),
  ) {
    const { lanes, bodies, rows, tracks, timeline } = latest.current;
    const root = lanes.current;
    const ppf = view()?.ppf;
    if (!root || !ppf) return;
    const top = new Map(rows.map((row) => [row.track.index, row.top]));
    const before = new Map(base.clips.map((clip) => [clip.id, clip]));
    const surviving = new Set(shown.clips.map((clip) => clip.id));
    const next = new Map<string, Offset & { scale: number }>();
    if (shown !== base)
      for (const clip of shown.clips) {
        const old = before.get(clip.id);
        if (
          !old ||
          (old.start === clip.start &&
            old.track === clip.track &&
            old.duration === clip.duration)
        )
          continue;
        const from = top.get(old.track) ?? 0;
        next.set(clip.id, {
          x: (clip.start - old.start) * ppf,
          y: (top.get(clip.track) ?? from) - from,
          scale: clip.duration / old.duration,
        });
      }
    if (shown !== base || next.size || placed.current.size || preview.current)
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-clip], [data-clip-label], [data-clip-outline], [data-agent-change], [data-clip-mix]",
      )) {
        const { clip, clipLabel, clipOutline, agentChange, clipMix } =
          element.dataset;
        const id =
          clip ?? clipLabel ?? clipOutline ?? agentChange ?? clipMix ?? "";
        element.hidden = !surviving.has(id);
        const at = next.get(id);
        const move = at ? `translate(${at.x}px, ${at.y}px)` : "";
        const held = at ? `${move} scaleX(${at.scale})` : "";
        if ((written.current.get(element) ?? "") === held) continue;
        written.current.set(element, held);
        element.style.transform = clipLabel === undefined ? held : move;
        element.toggleAttribute("data-held", at !== undefined);
        // The outline's brackets keep their width while the outline stretches.
        if (clipOutline !== undefined)
          element.style.setProperty("--k", String(at?.scale ?? 1));
        // A name is not stretched; a shortened clip shows as much of it as still fits.
        if (clipLabel !== undefined)
          element.style.clipPath =
            at && at.scale < 1 ? `inset(0 ${(1 - at.scale) * 100}% 0 0)` : "";
      }
    for (const clip of shown.clips) {
      const old = before.get(clip.id);
      if (
        old?.volume === clip.volume &&
        old.fadeIn === clip.fadeIn &&
        old.fadeOut === clip.fadeOut &&
        old.automation === clip.automation &&
        old.duration === clip.duration &&
        !preview.current?.commands.some(
          (command) => command.type === "setClip" && command.clipId === clip.id,
        )
      )
        continue;
      const mix = root.querySelector<HTMLElement>(
        `[data-clip-mix="${CSS.escape(clip.id)}"]`,
      );
      const gain = mix?.querySelector<HTMLElement>('[data-mix="gain"]');
      if (gain) gain.style.top = `${gainHeight(clip.volume)}%`;
      mix?.querySelector("path")?.setAttribute("d", fadePath(clip, shown.fps));
      for (const edge of ["fadeIn", "fadeOut"] as const) {
        const handle = mix?.querySelector<HTMLElement>(`[data-mix="${edge}"]`);
        if (handle)
          handle.style[edge === "fadeIn" ? "left" : "right"] =
            `${(clip[edge] / clip.duration) * 100}%`;
      }
    }
    placed.current = next;

    // Pieces the edit cuts off have no element yet: each gets a box of its clip's kind.
    const boxes = pieces.current;
    const made = [...cut].flatMap(([id, from]) => {
      const piece = shown.clips.find((clip) => clip.id === id);
      const source = before.get(from);
      const row = rowOf(piece?.track);
      return piece && source && row ? [{ piece, source, row }] : [];
    });
    if (boxes)
      for (
        let index = 0;
        index < Math.max(made.length, boxes.children.length);
        index++
      ) {
        const box =
          boxes.children[index] ??
          boxes.appendChild(document.createElement("i"));
        const item = made[index];
        if (!(box instanceof HTMLElement)) continue;
        box.hidden = !item;
        if (!item) continue;
        const { piece, source, row } = item;
        box.className = `tl-clip tl-piece ${source.kind} on-${row.track.kind}${source.enabled ? "" : " disabled"}`;
        box.style.transform = `translate(${piece.start * ppf}px, ${row.top}px) scaleX(${Math.max(1, piece.duration * ppf - 1)})`;
      }
    bodies.current?.scene({
      rows,
      tracks: shown === timeline ? tracks : clipsByTrack(shown.clips),
      fps: shown.fps,
    });
  }

  /** Reports conflicts against the held destination before pointer geometry can change it. */
  function refuseChanged(base: Timeline, next: Preview) {
    const { timeline } = latest.current;
    if (
      timeline === base ||
      !anchorsChanged(editAnchors(base, next.shown, next.commands), timeline)
    )
      return false;
    // The queue reports the conflict without sending.
    latest.current.onEdit(next.label, next.commands, base);
    return true;
  }

  /** Draws what a drag or drop would do. */
  function render(base: Timeline, next: Preview) {
    preview.current = next;
    if (refuseChanged(base, next)) {
      end("cancel");
      return;
    }
    const { timeline } = latest.current;
    // Keep the commands frozen, but show unrelated agent edits underneath the held drag.
    const over =
      timeline !== base ? previewCommands(timeline, next.commands) : null;
    place(timeline, over?.timeline ?? next.shown, over?.pieces ?? next.pieces);
    mark(snapLine.current, next.snap);
    latest.current.lanes.current?.toggleAttribute("data-refused", !next.valid);
  }

  /** Takes every trace of a preview away and returns where it held the clips. */
  function clear() {
    const { timeline, lanes } = latest.current;
    const offsets = placed.current;
    if (preview.current) place(timeline, timeline);
    for (const element of [
      snapLine.current,
      bladeLine.current,
      ghost.current,
      readout.current,
      marquee.current,
    ])
      if (element) element.hidden = true;
    lanes.current?.removeAttribute("data-refused");
    preview.current = null;
    drawn.current = "";
    return offsets;
  }

  function hitAt(event: PointerEvent): Hit | null {
    if (!(event.target instanceof Element)) return null;
    const element = event.target.closest<HTMLElement>(
      "[data-clip], [data-clip-mix]",
    );
    const clip = latest.current.timeline.clips.find(
      (item) => item.id === (element?.dataset.clip ?? element?.dataset.clipMix),
    );
    if (!element || !clip) return null;
    const box = element.getBoundingClientRect();
    const mix = event.target.closest<HTMLElement>("[data-mix]")?.dataset.mix;
    return {
      clip,
      x: event.clientX - box.left,
      width: box.width,
      ...(mix === "gain" || mix === "fadeIn" || mix === "fadeOut"
        ? { mix }
        : {}),
    };
  }

  function drawMarquee() {
    const current = gesture.current;
    const box = marquee.current;
    const ppf = view()?.ppf;
    if (current.phase !== "dragging" || !box || !ppf) return;
    const { timeline, rows, selection, onSelect } = latest.current;
    const { origin, point } = current;
    const left = Math.min(point.x, origin.x);
    const top = Math.min(point.y, origin.y);
    const right = Math.max(point.x, origin.x);
    const bottom = Math.max(point.y, origin.y);
    box.hidden = false;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${right - left}px`;
    box.style.height = `${bottom - top}px`;
    const next = marqueeSelection(
      timeline,
      rowsBetween(rows, top, bottom).map((row) => row.track.index),
      { from: left / ppf, to: right / ppf },
      marqueeBase.current,
    );
    if (!sameIds(next.ids, selection.ids)) onSelect(next);
  }

  /** Draws the drag as the pointer stands: after a pointer move, a scroll, or a zoom under it. */
  function update() {
    const current = gesture.current;
    const active = drag.current;
    const ppf = view()?.ppf;
    if (current.phase !== "dragging" || !ppf) return;
    if (current.intent.kind === "marquee") return drawMarquee();
    if (!active) return;
    if (preview.current && refuseChanged(active.timeline, preview.current)) {
      end("cancel");
      return;
    }
    const { x, y, bypass } = pointer.current;
    // Measure before the preview writes hundreds of transforms; reading after forces layout.
    const at = local(x, y);
    const input = {
      frame: frameAt(x),
      track: rowAt(y)?.track.index ?? null,
      reach: reach(bypass),
      dy: active.intent.kind === "gain" ? at.y - current.origin.y : 0,
    };
    const key = `${input.frame}:${input.track}:${input.reach}:${ppf}:${input.dy}`;
    if (key !== drawn.current) {
      drawn.current = key;
      const next = dragPreview(active, input);
      render(active.timeline, next);
      if (!drag.current) return;
      const { intent } = active;
      if (intent.kind === "blade") {
        const clip = active.timeline.clips.find(
          (item) => item.id === intent.clipId,
        );
        mark(
          bladeLine.current,
          next.valid ? (next.at ?? null) : null,
          rowOf(clip?.track),
        );
      } else if (readout.current) {
        readout.current.textContent =
          intent.kind === "gain"
            ? audioGainToText(
                next.shown.clips.find((clip) => clip.id === intent.clipId)
                  ?.volume ?? 1,
              )
            : `${next.delta < 0 ? "-" : "+"}${formatTimecode(Math.abs(next.delta), active.timeline.fps)}`;
        readout.current.hidden = false;
      }
    }
    if (readout.current && !readout.current.hidden) {
      readout.current.style.transform = `translate(${at.x + 14}px, ${at.y + 18}px)`;
    }
  }

  function finish(outcome: Outcome) {
    const { lanes, selection, timeline, rows, onSelect } = latest.current;
    const active = drag.current;
    const alone = kept.current;
    drag.current = null;
    kept.current = null;
    lanes.current?.removeAttribute("data-cursor");
    latest.current.onGesture(false);

    if (!active) {
      // A marquee: a click on an empty lane without a modifier deselects.
      clear();
      if (
        outcome === "click" &&
        marqueeBase.current === emptySelection &&
        selection.ids.size
      )
        onSelect(emptySelection);
      return;
    }
    if (outcome === "click" && active.intent.kind !== "blade") {
      clear();
      if (alone)
        onSelect(
          clickSelection(
            timeline,
            rows.map((row) => row.track.index),
            selection,
            alone,
            { toggle: false, range: false, alone: false },
          ),
        );
      return;
    }
    // Release always uses the modifiers held now, even without a final pointer move.
    const conflict =
      outcome === "commit" &&
      preview.current !== null &&
      refuseChanged(active.timeline, preview.current);
    const result =
      outcome === "cancel" || conflict
        ? null
        : dragPreview(active, {
            frame: frameAt(pointer.current.x),
            track: rowAt(pointer.current.y)?.track.index ?? null,
            reach: reach(pointer.current.bypass),
            dy: local(pointer.current.x, pointer.current.y).y - originY.current,
          });
    settle(result, active.timeline);
  }

  /** Ends a preview: with its edit when it has one the editor takes, otherwise by going back. */
  function settle(result: Preview | null, basis?: Timeline) {
    const { lanes, bodies, onEdit } = latest.current;
    const offsets = clear();
    if (
      result?.valid !== false &&
      result?.commands.length &&
      onEdit(result.label, result.commands, basis)
    ) {
      // The clips are where the edit puts them already; `useClipMotion` slides only the rest.
      held.current = offsets;
      return;
    }
    // A refused move still asks the editor, which says why in the header.
    if (result && !result.valid) onEdit(result.label, result.commands, basis);
    if (lanes.current)
      slideClips(lanes.current, offsets, (slides) =>
        bodies.current?.slide(slides),
      );
  }

  function hover(event: PointerEvent) {
    const { tool, timeline, lanes, playhead } = latest.current;
    const root = lanes.current;
    const hit = hitAt(event);
    const intent = intentAt(tool, timeline, hit);
    // The pointer and an empty lane keep the default cursor.
    const cursor =
      !intent || intent.kind === "move" || intent.kind === "marquee"
        ? undefined
        : intent.kind;
    if (root && root.dataset.cursor !== cursor) {
      if (cursor) root.dataset.cursor = cursor;
      else delete root.dataset.cursor;
    }
    if (intent?.kind !== "blade" || !hit) {
      mark(bladeLine.current, null);
      mark(snapLine.current, null);
      return;
    }
    const frame = playhead();
    if (
      hoverTargets.current?.timeline !== timeline ||
      hoverTargets.current.playhead !== frame
    )
      hoverTargets.current = {
        timeline,
        playhead: frame,
        frames: snapTargets(timeline, frame),
      };
    const cut = bladePreview(
      timeline,
      hit.clip,
      frameAt(event.clientX),
      hoverTargets.current.frames,
      reach(event.ctrlKey || event.metaKey),
    );
    mark(
      bladeLine.current,
      cut.valid ? (cut.at ?? null) : null,
      rowOf(hit.clip.track),
    );
    mark(snapLine.current, cut.snap);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || gesture.current.phase !== "idle") return;
    const { tool, timeline, rows, selection, onSelect, onGesture, playhead } =
      latest.current;
    const hit = hitAt(event);
    const toggle = event.ctrlKey || event.metaKey;
    const intent = intentAt(tool, timeline, hit, event.altKey);
    // A press on a selected clip keeps the selection, so several clips drag as one.
    const keep =
      hit !== null &&
      intent?.kind === "move" &&
      !toggle &&
      !event.shiftKey &&
      !event.altKey &&
      selection.ids.has(hit.clip.id);
    let selected = selection;
    if (hit && tool !== "blade") {
      if (intent?.kind === "roll")
        selected = {
          ids: new Set([intent.left, intent.right]),
          anchor: hit.clip.id,
        };
      else if (!keep)
        selected = clickSelection(
          timeline,
          rows.map((row) => row.track.index),
          selection,
          hit.clip.id,
          { toggle, range: event.shiftKey, alone: event.altKey },
        );
      if (selected !== selection) onSelect(selected);
    }
    // Ctrl and Shift presses edit the selection; they never start a drag of it.
    if (!intent || (hit && tool !== "blade" && (toggle || event.shiftKey)))
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { x: event.clientX, y: event.clientY, bypass: toggle };
    gesture.current = step(gesture.current, {
      type: "press",
      intent,
      point: local(event.clientX, event.clientY),
    }).gesture;
    originY.current = local(event.clientX, event.clientY).y;
    onGesture(true);
    if (intent.kind === "marquee") {
      marqueeBase.current =
        toggle || event.shiftKey ? selection : emptySelection;
      return;
    }
    kept.current = keep && hit && selection.ids.size > 1 ? hit.clip.id : null;
    event.currentTarget.dataset.cursor = intent.kind;
    drag.current = beginDrag(
      timeline,
      intent,
      selected.ids,
      frameAt(event.clientX),
      playhead(),
    );
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current.phase === "idle") return hover(event);
    pointer.current = {
      x: event.clientX,
      y: event.clientY,
      bypass: event.ctrlKey || event.metaKey,
    };
    gesture.current = step(gesture.current, {
      type: "move",
      point: local(event.clientX, event.clientY),
    }).gesture;
    update();
  }

  function end(type: "release" | "cancel") {
    const next = step(gesture.current, { type });
    gesture.current = next.gesture;
    if (next.outcome) finish(next.outcome);
  }

  // Esc cancels before any other shortcut hears it. Modifier changes redraw a stationary drag.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (gesture.current.phase === "idle") return;
      if (event.key === "Escape" && event.type === "keydown") {
        event.preventDefault();
        event.stopPropagation();
        end("cancel");
        return;
      }
      pointer.current.bypass = event.ctrlKey || event.metaKey;
      update();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("keyup", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("keyup", key, true);
      end("cancel");
    };
  }, []);
  // Server answers may replace the timeline, but never the gesture's starting point or commands.
  useLayoutEffect(() => {
    drawn.current = "";
    update();
  }, [options.timeline, options.snapping]);

  /** Media over the lanes, as `dropPreview` reads it; null when the drag is not project media. */
  function dropAt(event: DragEvent) {
    const media = mediaDrag();
    if (!media || !event.dataTransfer.types.includes(MEDIA_DRAG_TYPE))
      return null;
    let row = rowAt(event.clientY);
    const rows = latest.current.rows;
    const { y } = local(event.clientX, event.clientY);
    const first = rows[0];
    const last = rows.at(-1);
    const above = first && y < first.top && media.kind !== "audio";
    const below = last && y >= last.top + last.height && media.kind === "audio";
    const creating = above || below;
    if (creating) {
      const kind = above ? "video" : "audio";
      row = {
        track: newTrack(nextTrackIndex(rows.map((row) => row.track)), kind),
        id: kind === "video" ? "New video track" : "New audio track",
        top: above ? 0 : last!.top + last!.height + 1,
        height: above ? first!.height : last!.height,
      };
    }
    const { timeline, playhead } = latest.current;
    const { fps } = timeline;
    const dragged = {
      kind: media.kind,
      src: media.path,
      frames: Math.max(1, Math.floor((media.seconds * fps.num) / fps.den)),
      hasAudio: media.hasAudio,
    };
    return {
      media: dragged,
      row,
      preview:
        row &&
        dropPreview(
          timeline,
          dragged,
          row.track,
          frameAt(event.clientX),
          playhead(),
          reach(event.ctrlKey || event.metaKey),
          creating
            ? rows
                .filter(
                  (row) =>
                    !timeline.tracks.some(
                      (track) => track.index === row.track.index,
                    ),
                )
                .map((row) => row.track)
            : [],
        ),
    };
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    const over = dropAt(event);
    if (!over) return;
    event.preventDefault();
    const { preview: drop, row, media } = over;
    // A refused preview still needs the native drop so the edit can explain why in the header.
    event.dataTransfer.dropEffect = drop ? "copy" : "none";
    const box = ghost.current;
    const ppf = view()?.ppf;
    if (!drop || !row || !box || !ppf) return;
    const key = `${drop.at}:${row.track.index}:${ppf}`;
    if (key === drawn.current) return;
    drawn.current = key;
    render(latest.current.timeline, drop);
    box.className = `tl-ghost ${media.kind}`;
    box.dataset.newTrack = latest.current.rows.some(
      (item) => item.track.index === row.track.index,
    )
      ? "false"
      : "true";
    box.style.width = `${Math.max(1, media.frames * ppf - 1)}px`;
    box.textContent = `${box.dataset.newTrack === "true" ? `${row.id}: ` : ""}${media.src.split("/").at(-1) ?? ""}`;
    mark(box, drop.at ?? 0, row);
  }

  // The preview moves clips under the pointer, and each one the drag crosses fires a leave on the
  // lanes. Only a pointer outside them has left; a drag that ends anywhere ends the preview.
  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX < box.right &&
      event.clientY >= box.top &&
      event.clientY < box.bottom;
    if (!inside) clear();
  }
  useEffect(() => {
    const ended = () => clear();
    document.addEventListener("dragend", ended);
    return () => document.removeEventListener("dragend", ended);
  }, []);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    const drop = dropAt(event)?.preview;
    if (!drop) return;
    event.preventDefault();
    settle(drop);
  }

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        pointer.current = {
          x: event.clientX,
          y: event.clientY,
          bypass: event.ctrlKey || event.metaKey,
        };
        end("release");
      },
      onPointerCancel: () => end("cancel"),
      onPointerLeave: () => {
        if (gesture.current.phase === "idle") {
          mark(bladeLine.current, null);
          mark(snapLine.current, null);
        }
      },
      // A browser takes the answer for a newly entered element from this event, not the next move.
      onDragEnter: onDragOver,
      onDragOver,
      onDragLeave,
      onDrop,
    },
    marks: { snapLine, bladeLine, ghost, readout, marquee, pieces },
    held,
    /** The view scrolled or zoomed: a drag under way is drawn again from where the pointer is. */
    refresh() {
      drawn.current = "";
      update();
    },
  };
}
