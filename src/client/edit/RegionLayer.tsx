import { useEffect, useLayoutEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import { MAX_ZOOM, defaultRegion } from "../../shared/timeline/region";
import type {
  Region,
  RegionBox,
  RegionEffect,
} from "../../shared/timeline/region";
import {
  ZOOMS_ASIDE,
  regionDraftRule,
} from "../../shared/timeline/regionStyle";
import { REGION_NAMES } from "../../shared/timeline/labels";
import { destinationTracks } from "../../shared/timeline/tracks";
import { isAudioKind } from "../../shared/timeline/schema";
import type { Clip } from "../../shared/timeline/schema";
import { blurPointerButton } from "../keymap";
import { useViewSettings } from "../timeline/viewSettings";
import { showToast } from "../workspace";
import { previewRegion } from "./preview";
import { addLayerCommands, zoomBoxAt, zoomTarget } from "./regionCommands";
import { editTimeline, useTimeline } from "./timeline";
import { useTransport } from "./transport";
import "./region.css";

/** Where a new zoom goes: on an adjustment layer over every picture, or on one clip. */
export type Placement = "layer" | "clip";

/** The tool's choices for the next box drawn, kept while the tool is put down. */
export const useRegionTool = create<{
  effect: RegionEffect;
  placement: Placement;
  /** Shows a zoom's result instead of the whole frame to aim in. */
  result: boolean;
}>(() => ({ effect: "zoom", placement: "layer", result: false }));

const EFFECTS = ["zoom", "blur", "highlight"] as const;
/** Travel before a press draws or moves instead of clicking. */
const DRAG_PX = 3;
/** Blur and highlight boxes are at least this much of the frame. */
const MIN_SIDE = 0.01;
const WHEEL_COMMIT_MS = 300;

type Corner = "nw" | "ne" | "sw" | "se";
type Gesture = {
  pointerId: number;
  /** Fractions of the frame where the press began. */
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  dragged: boolean;
  from: RegionBox | null;
} & ({ kind: "move" } | { kind: "resize"; corner: Corner } | { kind: "draw" });

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));
const round = (value: number) => Number(value.toFixed(6)) + 0;
const rounded = (box: RegionBox): RegionBox => ({
  x: round(box.x),
  y: round(box.y),
  width: round(box.width),
  height: round(box.height),
});

/**
 * The box between a fixed corner and the pointer. A zoom's box keeps the frame's shape, so its
 * width and height are the same fraction, the larger of the two, as far as the frame allows.
 */
function spanBox(
  ax: number,
  ay: number,
  px: number,
  py: number,
  zoom: boolean,
): RegionBox {
  const left = px < ax;
  const up = py < ay;
  if (!zoom) {
    const x = clamp(Math.min(ax, px), 0, 1);
    const y = clamp(Math.min(ay, py), 0, 1);
    const width = clamp(Math.abs(px - ax), MIN_SIDE, 1 - x);
    const height = clamp(Math.abs(py - ay), MIN_SIDE, 1 - y);
    return {
      x: left ? Math.min(x, 1 - width) : x,
      y: up ? Math.min(y, 1 - height) : y,
      width,
      height,
    };
  }
  const room = Math.min(left ? ax : 1 - ax, up ? ay : 1 - ay);
  const side = clamp(
    Math.max(Math.abs(px - ax), Math.abs(py - ay)),
    1 / MAX_ZOOM,
    Math.max(1 / MAX_ZOOM, room),
  );
  return {
    x: clamp(left ? ax - side : ax, 0, 1 - side),
    y: clamp(up ? ay - side : ay, 0, 1 - side),
    width: side,
    height: side,
  };
}

/** The box grown or shrunk about its centre: a wheel notch, or a typed zoom. */
function scaleBox(box: RegionBox, factor: number, zoom: boolean): RegionBox {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (zoom)
    return zoomBoxAt(cx, cy, clamp(box.width * factor, 1 / MAX_ZOOM, 1));
  const width = clamp(box.width * factor, MIN_SIDE, 1);
  const height = clamp(box.height * factor, MIN_SIDE, 1);
  return {
    x: clamp(cx - width / 2, 0, 1 - width),
    y: clamp(cy - height / 2, 0, 1 - height),
    width,
    height,
  };
}

const sameBox = (a: RegionBox, b: RegionBox) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * The zoom, blur and highlight tool on the picture. A box is drawn by dragging, moved by its
 * middle and resized from its corners; the wheel magnifies and a double-click resets it. Each
 * gesture commits one edit. While aiming, every zoom is set aside so the whole frame shows, and a
 * blur or highlight follows the box in the preview as it moves.
 */
export function RegionLayer({
  projectId,
  box,
  frame,
}: {
  projectId: string;
  /** The picture's place in the stage, in CSS pixels. */
  box: { left: number; top: number; width: number; height: number };
  /** The composition's size. */
  frame: { width: number; height: number };
}) {
  const timeline = useTimeline((state) => state.view?.timeline);
  const anchor = useTimeline((state) => state.selection.anchor);
  const { effect: chosen, placement, result } = useRegionTool();
  const selected = timeline?.clips.find((clip) => clip.id === anchor) ?? null;
  const target: (Clip & { region: Region }) | null =
    selected?.region && !isAudioKind(selected.kind)
      ? { ...selected, region: selected.region }
      : null;
  const effect = target?.region.effect ?? chosen;
  const zoom = effect === "zoom";
  const locked =
    target !== null &&
    (timeline?.tracks.find((track) => track.index === target.track)?.locked ??
      false);
  const aiming = !(zoom && result);
  const saved = target?.region.box ?? null;

  const surface = useRef<HTMLDivElement>(null);
  const shape = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const draft = useRef<RegionBox | null>(null);
  const wheel = useRef<{ timer: number; box: RegionBox } | null>(null);
  const frameRequest = useRef(0);
  const latest = useRef({ target, saved, aiming });
  latest.current = { target, saved, aiming };

  /**
   * The preview's region CSS while the tool is up: zooms set aside to aim, and a blur or highlight
   * drawn from the editor's own timeline, at the box being dragged or the saved one. Drawing the
   * saved look too keeps an undone or just-committed box in place before the preview reloads.
   */
  const regionCss = (next: RegionBox | null) => {
    const current = latest.current.target;
    const look =
      current && current.region.effect !== "zoom"
        ? regionDraftRule(
            current.id,
            { ...current.region, box: next ?? current.region.box },
            frame,
          )
        : null;
    return (
      [latest.current.aiming ? ZOOMS_ASIDE : null, look]
        .filter(Boolean)
        .join("\n") || null
    );
  };

  /** Places the box and its readout outside React, so a drag repaints only them. */
  const place = (next: RegionBox | null) => {
    const element = shape.current;
    if (!element) return;
    element.hidden = next === null || !latest.current.aiming;
    if (next) {
      element.style.transform = `translate(${next.x * box.width}px, ${next.y * box.height}px)`;
      element.style.width = `${next.width * box.width}px`;
      element.style.height = `${next.height * box.height}px`;
    }
    // What a zoom will cut off recedes: four bands around the box, sized by transform alone.
    const bands = scrim.current?.children as
      HTMLCollectionOf<HTMLElement> | undefined;
    if (bands && next) {
      const [x, y] = [next.x * box.width, next.y * box.height];
      const [w, h] = [next.width * box.width, next.height * box.height];
      const set = (
        at: number,
        left: number,
        top: number,
        sx: number,
        sy: number,
      ) =>
        (bands[at]!.style.transform =
          `translate(${left}px, ${top}px) scale(${Math.max(0, sx)}, ${Math.max(0, sy)})`);
      set(0, 0, 0, box.width, y);
      set(1, 0, y + h, box.width, box.height - y - h);
      set(2, 0, y, x, h);
      set(3, x + w, y, box.width - x - w, h);
    }
    if (scrim.current)
      scrim.current.hidden = !zoom || next === null || !latest.current.aiming;
    if (readout.current)
      readout.current.textContent =
        next && zoom ? `${Math.round(100 / next.width)}%` : "";
  };
  const show = (next: RegionBox | null) => {
    draft.current = next;
    place(next ?? latest.current.saved);
    if (frameRequest.current) return;
    frameRequest.current = requestAnimationFrame(() => {
      frameRequest.current = 0;
      previewRegion(regionCss(draft.current));
    });
  };

  useLayoutEffect(() => {
    if (!gesture.current && !wheel.current) place(saved);
  });
  // The whole frame shows while aiming; leaving the tool or previewing brings zooms back.
  useEffect(() => {
    previewRegion(regionCss(null), true);
  }, [aiming]);
  const look = target && JSON.stringify([target.id, target.region]);
  useEffect(() => {
    if (!gesture.current && !wheel.current) previewRegion(regionCss(null));
  }, [look]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frameRequest.current);
      if (wheel.current) window.clearTimeout(wheel.current.timer);
      previewRegion(null, true);
    },
    [],
  );

  const commit = (next: RegionBox) => {
    const current = latest.current.target;
    const final = rounded(next);
    if (current) {
      if (sameBox(final, current.region.box)) return show(null);
      void editTimeline(
        projectId,
        `Move ${REGION_NAMES[current.region.effect].toLowerCase()}`,
        () => [{ type: "setClip", clipId: current.id, region: { box: final } }],
      ).finally(() => {
        if (!gesture.current && !wheel.current) show(null);
      });
      return;
    }
    const at = useTransport.getState().frame;
    const select = (id: string | undefined) => {
      if (id !== undefined)
        useTimeline.setState({ selection: { ids: new Set([id]), anchor: id } });
    };
    if (zoom && placement === "clip") {
      const picture = timeline && zoomTarget(timeline, anchor, at);
      if (!picture) {
        show(null);
        showToast("There is no picture at the playhead to zoom.");
        return;
      }
      void editTimeline(
        projectId,
        "Add zoom",
        () => [
          {
            type: "setClip",
            clipId: picture.id,
            region: { effect: "zoom", box: final },
          },
        ],
        undefined,
        () => select(picture.id),
      ).finally(() => show(null));
      return;
    }
    void editTimeline(
      projectId,
      `Add ${REGION_NAMES[effect].toLowerCase()}`,
      (current) =>
        addLayerCommands(
          current,
          destinationTracks(
            current.tracks,
            useViewSettings.getState().destinations,
          ).video,
          at,
          effect,
          final,
        ),
      undefined,
      (_, commands) =>
        select(commands.find((command) => command.type === "insert")?.clip.id),
    ).finally(() => show(null));
  };

  const fraction = (event: { clientX: number; clientY: number }) => {
    const bounds = surface.current!.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
    };
  };
  const shown = () => draft.current ?? latest.current.saved;
  const defaultBox = () =>
    defaultRegion(effect, timeline?.fps ?? { num: 30, den: 1 }).box;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || locked || !aiming) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = fraction(event);
    const handle = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-corner]",
    );
    const current = shown();
    const inside =
      current &&
      point.x >= current.x &&
      point.x <= current.x + current.width &&
      point.y >= current.y &&
      point.y <= current.y + current.height;
    const common = {
      pointerId: event.pointerId,
      ...point,
      clientX: event.clientX,
      clientY: event.clientY,
      dragged: false,
      from: current,
    };
    gesture.current = handle
      ? { ...common, kind: "resize", corner: handle.dataset.corner as Corner }
      : inside
        ? { ...common, kind: "move" }
        : { ...common, kind: "draw" };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (
      !current.dragged &&
      Math.hypot(
        event.clientX - current.clientX,
        event.clientY - current.clientY,
      ) < DRAG_PX
    )
      return;
    current.dragged = true;
    const point = fraction(event);
    const { from } = current;
    if (current.kind === "move" && from) {
      show({
        ...from,
        x: clamp(from.x + point.x - current.x, 0, 1 - from.width),
        y: clamp(from.y + point.y - current.y, 0, 1 - from.height),
      });
      return;
    }
    if (current.kind === "resize" && from) {
      const ax = current.corner.endsWith("w") ? from.x + from.width : from.x;
      const ay = current.corner.startsWith("n") ? from.y + from.height : from.y;
      show(spanBox(ax, ay, point.x, point.y, zoom));
      return;
    }
    show(spanBox(current.x, current.y, point.x, point.y, zoom));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (current.dragged) {
      if (draft.current) commit(draft.current);
      return;
    }
    // A click away from the box aims it there, at the size it has.
    if (current.kind !== "draw") return;
    const size = current.from ?? defaultBox();
    commit(
      zoom
        ? zoomBoxAt(current.x, current.y, size.width)
        : {
            ...size,
            x: clamp(current.x - size.width / 2, 0, 1 - size.width),
            y: clamp(current.y - size.height / 2, 0, 1 - size.height),
          },
    );
  };
  const onPointerCancel = () => {
    gesture.current = null;
    show(null);
  };

  return (
    <>
      <div
        className="edit-region-bar"
        role="toolbar"
        aria-label="Zoom and highlight"
        // A clicked choice gives the keys back, so Space still plays.
        onClick={blurPointerButton}
        style={{ left: box.left + box.width / 2, top: box.top }}
      >
        {!target && (
          <Choice
            label="Effect"
            options={EFFECTS.map((value) => ({
              value,
              label: REGION_NAMES[value],
            }))}
            value={chosen}
            onChange={(next) => useRegionTool.setState({ effect: next })}
          />
        )}
        {!target && zoom && (
          <Choice
            label="Zoom on"
            options={[
              { value: "layer", label: "Adjustment layer" },
              { value: "clip", label: "Clip" },
            ]}
            value={placement}
            onChange={(next) => useRegionTool.setState({ placement: next })}
          />
        )}
        {zoom && (
          <Choice
            label="Show"
            options={[
              { value: "aim", label: "Aim" },
              { value: "result", label: "Result" },
            ]}
            value={result ? "result" : "aim"}
            onChange={(next) =>
              useRegionTool.setState({ result: next === "result" })
            }
          />
        )}
        <span ref={readout} className="edit-region-readout" />
      </div>
      <div
        ref={surface}
        className="edit-region"
        data-effect={effect}
        data-aiming={aiming || undefined}
        data-locked={locked || undefined}
        style={box}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={() => {
          if (gesture.current) onPointerCancel();
        }}
        onDoubleClick={() => {
          if (locked || !aiming) return;
          commit(defaultBox());
        }}
        onWheel={(event) => {
          const current = shown();
          if (!current || locked || !aiming || gesture.current) return;
          const next = scaleBox(
            wheel.current?.box ?? current,
            Math.exp(event.deltaY * 0.0015),
            zoom,
          );
          if (wheel.current) window.clearTimeout(wheel.current.timer);
          // Notches in a row are one edit.
          wheel.current = {
            box: next,
            timer: window.setTimeout(() => {
              const settled = wheel.current?.box;
              wheel.current = null;
              if (settled) commit(settled);
            }, WHEEL_COMMIT_MS),
          };
          show(next);
        }}
      >
        <div ref={scrim} className="edit-region-scrim" hidden>
          <i />
          <i />
          <i />
          <i />
        </div>
        <div ref={shape} className="edit-region-box" hidden>
          <b data-corner="nw" />
          <b data-corner="ne" />
          <b data-corner="sw" />
          <b data-corner="se" />
        </div>
      </div>
    </>
  );
}

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange(value: T): void;
}) {
  return (
    <div className="edit-region-choice" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
