import { useLayoutEffect, useRef } from "react";
import { useWorkspace } from "../workspace";

const widthKey = "cutroom.leftWidth";

export function WorkspaceDivider() {
  const handle = useRef<HTMLDivElement>(null);
  const dockedInspector = useWorkspace((state) => state.inspector);

  useLayoutEffect(() => {
    const divider = handle.current;
    const workspace = divider?.parentElement;
    if (!divider || !workspace) return;

    const style = getComputedStyle(workspace);
    const minimum = parseFloat(style.getPropertyValue("--width-left-min"));
    const preferred = parseFloat(style.getPropertyValue("--width-left"));
    const limit = parseFloat(style.getPropertyValue("--width-left-max"));
    const centre = parseFloat(style.getPropertyValue("--width-centre-min"));
    const inspector = parseFloat(style.getPropertyValue("--width-inspector"));
    const seam = parseFloat(style.columnGap);
    const persisted = Number(sessionStorage.getItem(widthKey));
    let saved =
      persisted > 0 && Number.isFinite(persisted) ? persisted : preferred;
    let maximum = minimum;
    let width = 0;
    let drag: {
      id: number;
      start: number;
      origin: number;
      next: number;
    } | null = null;
    let frame = 0;

    const clamp = (requested: number) =>
      Math.min(maximum, Math.max(minimum, Math.round(requested)));
    const show = (requested: number) => {
      const next = clamp(requested);
      if (next === width) return;
      width = next;
      workspace.style.gridTemplateColumns = `${width}px minmax(0, 1fr)`;
      divider.setAttribute("aria-valuenow", String(width));
    };
    // Reflow the transcript and redraw the timeline once, when the drag lands.
    const preview = (requested: number) => {
      divider.style.translate = `${clamp(requested) - width}px`;
    };
    const fit = () => {
      const reserve = dockedInspector ? inspector : 0;
      maximum = Math.max(
        minimum,
        Math.min(limit, workspace.clientWidth - centre - reserve - seam),
      );
      divider.setAttribute("aria-valuemax", String(maximum));
      show(saved);
      if (drag) preview(drag.next);
    };
    divider.setAttribute("aria-valuemin", String(minimum));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(workspace);

    const save = (requested: number) => {
      show(requested);
      saved = width;
      sessionStorage.setItem(widthKey, String(width));
    };
    const reset = () => {
      saved = preferred;
      sessionStorage.removeItem(widthKey);
      show(saved);
    };
    const press = (event: KeyboardEvent) => {
      const step = 16;
      switch (event.key) {
        case "ArrowLeft":
          save(width - step);
          break;
        case "ArrowRight":
          save(width + step);
          break;
        case "Home":
          save(minimum);
          break;
        case "End":
          save(maximum);
          break;
        case "Enter":
          reset();
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    const start = (event: PointerEvent) => {
      if (event.button !== 0 || drag) return;
      drag = {
        id: event.pointerId,
        start: event.clientX,
        origin: width,
        next: width,
      };
      divider.setPointerCapture(event.pointerId);
      divider.dataset.dragging = "";
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const current = drag;
      current.next = current.origin + event.clientX - current.start;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        preview(current.next);
      });
    };
    const finish = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const { origin, next } = drag;
      drag = null;
      cancelAnimationFrame(frame);
      frame = 0;
      delete divider.dataset.dragging;
      divider.style.removeProperty("translate");
      if (event.type === "pointerup" && next !== origin) save(next);
      else show(saved);
    };
    divider.addEventListener("keydown", press);
    divider.addEventListener("dblclick", reset);
    divider.addEventListener("pointerdown", start);
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", finish);
    divider.addEventListener("lostpointercapture", finish);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      workspace.style.removeProperty("grid-template-columns");
      divider.style.removeProperty("translate");
      delete divider.dataset.dragging;
      divider.removeEventListener("keydown", press);
      divider.removeEventListener("dblclick", reset);
      divider.removeEventListener("pointerdown", start);
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", finish);
      divider.removeEventListener("lostpointercapture", finish);
    };
  }, [dockedInspector]);

  return (
    <div
      ref={handle}
      className="workspace-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize left panel"
      aria-controls="work-panel"
      tabIndex={0}
      title="Resize left panel. Double-click to reset."
    />
  );
}
