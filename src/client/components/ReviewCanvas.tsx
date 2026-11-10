import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent } from "react";
import type { EditorPoint, EditorReviewDraft } from "../../shared/editor";

export interface ReviewTarget {
  time: number;
  compositionPath: string;
  elementIds: string[];
}

/**
 * Draw or pin a comment on the picture. Fills its positioned parent, which must match the
 * composition's rectangle. `begin` stops playback and names the frame being marked.
 */
export function ReviewCanvas({
  mode,
  begin,
  onReview,
}: {
  mode: "draw" | "comment";
  begin: () => ReviewTarget;
  onReview?: (draft: EditorReviewDraft) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const points = useRef<EditorPoint[]>([]);
  const drawnPoints = useRef(0);
  const paintFrame = useRef<number | null>(null);
  const pointer = useRef<number | null>(null);
  const target = useRef<ReviewTarget | null>(null);

  const draw = useCallback(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    const width = element.clientWidth;
    const height = element.clientHeight;
    const pixelWidth = Math.round(width * devicePixelRatio);
    const pixelHeight = Math.round(height * devicePixelRatio);
    if (element.width !== pixelWidth || element.height !== pixelHeight) {
      element.width = pixelWidth;
      element.height = pixelHeight;
      drawnPoints.current = 0;
    }
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    if (!points.current.length) {
      ctx.clearRect(0, 0, width, height);
      drawnPoints.current = 0;
      return;
    }
    if (drawnPoints.current === points.current.length) return;
    if (!drawnPoints.current) ctx.clearRect(0, 0, width, height);
    const tokens = getComputedStyle(element);
    ctx.lineWidth = parseFloat(tokens.getPropertyValue("--stroke-pencil"));
    ctx.strokeStyle = tokens.getPropertyValue("--human");
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (
      let index = Math.max(0, drawnPoints.current - 1);
      index < points.current.length;
      index++
    ) {
      const point = points.current[index];
      if (!point) continue;
      const x = point.x * width;
      const y = point.y * height;
      if (index === Math.max(0, drawnPoints.current - 1)) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    drawnPoints.current = points.current.length;
  }, []);
  const scheduleDraw = useCallback(() => {
    if (paintFrame.current !== null) return;
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = null;
      draw();
    });
  }, [draw]);
  const clearDrawing = useCallback(() => {
    if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current);
    paintFrame.current = null;
    pointer.current = null;
    points.current = [];
    drawnPoints.current = 0;
    draw();
  }, [draw]);
  useEffect(
    () => () => {
      if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current);
    },
    [],
  );

  const pointFor = (event: PointerEvent<HTMLCanvasElement>): EditorPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  const finish = (event: PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const marked = target.current;
    if (marked && points.current.length > 0)
      onReview?.({
        time: marked.time,
        compositionPath: marked.compositionPath,
        point: points.current[0],
        strokes: mode === "draw" ? [[...points.current]] : [],
        elementIds: marked.elementIds,
      });
    clearDrawing();
  };

  return (
    <canvas
      ref={canvas}
      className="editor-review-canvas"
      aria-label={
        mode === "draw"
          ? "Draw on the composition"
          : "Pin a comment on the composition"
      }
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "auto",
        touchAction: "none",
        cursor: mode === "draw" ? "crosshair" : "cell",
      }}
      onPointerDown={(event) => {
        target.current = begin();
        pointer.current = event.pointerId;
        points.current = [pointFor(event)];
        drawnPoints.current = 0;
        event.currentTarget.setPointerCapture(event.pointerId);
        scheduleDraw();
      }}
      onPointerMove={(event) => {
        if (pointer.current !== event.pointerId || mode !== "draw") return;
        points.current.push(pointFor(event));
        scheduleDraw();
      }}
      onPointerUp={finish}
      onPointerCancel={clearDrawing}
    />
  );
}
