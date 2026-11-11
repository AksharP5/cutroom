import { useEffect, useRef } from "react";
import type { PointerEvent, RefObject } from "react";
import { MAX_TRACK_HEIGHT, MIN_TRACK_HEIGHT } from "../../shared/timeline/view";
import type { TimelineViewSettings } from "../../shared/timeline/view";
import type { Track } from "../../shared/timeline/schema";
import { trackRows } from "./math";
import type { Row, RowLayout, RowSizes } from "./math";

/** A height drag moves row containers, never the individual clips they hold. */
export function useTrackResize(options: {
  root: RefObject<HTMLDivElement | null>;
  sizes: RowSizes;
  layout: RowLayout;
  tracks: readonly Track[];
  settings: TimelineViewSettings;
  draw(layout: RowLayout): void;
  save(settings: TimelineViewSettings): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const active = useRef<{ row: Row; y: number; height: number } | null>(null);
  const queued = useRef(0);
  function show(layout: RowLayout) {
    const root = latest.current.root.current;
    if (!root) return;
    for (const row of layout.rows) {
      for (const element of root.querySelectorAll<HTMLElement>(
        `[data-row="${row.track.index}"]`,
      )) {
        element.style.top = `${row.top}px`;
        element.style.height = `${row.height + (element.classList.contains("tl-row") ? 0 : latest.current.sizes.seam)}px`;
        if (element.classList.contains("tl-head")) {
          element.toggleAttribute("data-compact", row.height < 40);
          element
            .querySelector("[role=separator]")
            ?.setAttribute("aria-valuenow", String(row.height));
        }
      }
    }
    for (const element of root.querySelectorAll<HTMLElement>(".tl-divider"))
      element.style.top = `${layout.dividerTop}px`;
    for (const element of root.querySelectorAll<HTMLElement>(
      ".tl-lanes, .tl-heads",
    ))
      element.style.minHeight = `${layout.height}px`;
    latest.current.draw(layout);
  }
  function preview() {
    queued.current = 0;
    const drag = active.current;
    if (!drag) return;
    const { tracks, sizes, settings } = latest.current;
    show(
      trackRows(tracks, {
        ...sizes,
        heights: { ...settings.heights, [drag.row.track.index]: drag.height },
      }),
    );
  }
  function finish(commit: boolean) {
    const drag = active.current;
    if (!drag) return;
    cancelAnimationFrame(queued.current);
    queued.current = 0;
    if (commit) preview();
    else show(latest.current.layout);
    active.current = null;
    delete latest.current.root.current?.dataset.resizing;
    if (commit && drag.height !== drag.row.height)
      latest.current.save({
        ...latest.current.settings,
        heights: {
          ...latest.current.settings.heights,
          [drag.row.track.index]: drag.height,
        },
      });
  }
  useEffect(() => {
    const cancel = () => finish(false);
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !active.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
    return () => {
      cancelAnimationFrame(queued.current);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
    };
  }, []);
  return {
    start(event: PointerEvent<HTMLElement>, row: Row) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      active.current = { row, y: event.clientY, height: row.height };
      if (latest.current.root.current)
        latest.current.root.current.dataset.resizing = "";
    },
    move(event: PointerEvent<HTMLElement>) {
      const drag = active.current;
      if (!drag) return;
      drag.height = Math.max(
        MIN_TRACK_HEIGHT,
        Math.min(
          MAX_TRACK_HEIGHT,
          Math.round(drag.row.height + event.clientY - drag.y),
        ),
      );
      queued.current ||= requestAnimationFrame(preview);
    },
    finish,
  };
}
