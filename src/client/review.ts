import { z } from "zod";
import { AnnotationSchema } from "../shared/project";
import type { EditorReviewDraft } from "../shared/editor";
import { api, json } from "./api";

export async function saveReviewNote(
  projectId: string,
  draft: EditorReviewDraft,
  body: string,
) {
  let framePath: string | undefined;
  let captureError = "";
  if (draft.frameUrl) {
    let image: ImageBitmap | undefined;
    try {
      const response = await fetch(draft.frameUrl);
      if (!response.ok)
        throw new Error(`Frame capture failed (${response.status}).`);
      image = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const paint = canvas.getContext("2d");
      if (!paint) throw new Error("The browser could not draw the frame.");
      paint.drawImage(image, 0, 0);
      if (draft.kind === "draw" && draft.points.length) {
        paint.strokeStyle = "#f39a6a";
        paint.lineWidth = Math.max(3, image.width / 400);
        paint.lineCap = "round";
        paint.lineJoin = "round";
        paint.beginPath();
        for (const [index, point] of draft.points.entries()) {
          if (index === 0)
            paint.moveTo(point.x * image.width, point.y * image.height);
          else paint.lineTo(point.x * image.width, point.y * image.height);
        }
        paint.stroke();
      }
      const saved = await api(
        `/projects/${projectId}/attachments`,
        z.object({ path: z.string() }),
        json("POST", { image: canvas.toDataURL("image/png") }),
      );
      framePath = saved.path;
    } catch (error) {
      captureError = error instanceof Error ? error.message : String(error);
    } finally {
      image?.close();
    }
  }
  await api(
    `/projects/${projectId}/annotations`,
    AnnotationSchema,
    json("POST", {
      kind: draft.kind === "draw" ? "drawing" : "comment",
      body,
      time: draft.time,
      compositionPath: draft.compositionPath,
      elementId: draft.elementIds[0],
      point: draft.points[0],
      strokes:
        draft.kind === "draw" && draft.points.length
          ? [{ points: draft.points, color: "#f39a6a" }]
          : [],
      framePath,
    }),
  );
  return captureError;
}
