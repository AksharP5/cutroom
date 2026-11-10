import { z } from "zod";
import { AnnotationSchema } from "../shared/project";
import type { EditorReviewDraft } from "../shared/editor";
import type { ReviewItem } from "../shared/review";
import { api, json } from "./api";
import { strokePath } from "./edit/notes";
import { saveNoteInOrder, trackNoteCapture } from "./edit/noteStore";

/** Notes are numbered in the owner's order, the same in Review, on the ruler, and on the picture. */
export const noteNumbers = (items: readonly ReviewItem[]) =>
  new Map(items.map((item, index) => [item.id, index + 1]));

/** The server's render of the frame a note marks, without the marks. */
export function frameCaptureUrl(
  projectId: string,
  {
    time,
    compositionPath,
  }: Pick<EditorReviewDraft, "time" | "compositionPath">,
) {
  const params = new URLSearchParams({
    t: time.toFixed(3),
    format: "png",
    output: "source",
  });
  return `/api/projects/${encodeURIComponent(projectId)}/thumbnail/${encodeURIComponent(compositionPath)}?${params}`;
}

/** Post in commit order; frame rendering must never hold a note or the next save. */
export async function saveReviewNote(
  projectId: string,
  draft: EditorReviewDraft,
  body: string,
) {
  const tokens = getComputedStyle(document.documentElement);
  const pencil = tokens.getPropertyValue("--human").trim();
  const saved = saveNoteInOrder(projectId, () =>
    api(
      `/projects/${projectId}/annotations`,
      AnnotationSchema,
      json("POST", {
        id: draft.id,
        kind: draft.strokes.length ? "drawing" : "comment",
        body,
        time: draft.time,
        endTime: draft.endTime,
        compositionPath: draft.compositionPath,
        elementId: draft.elementIds[0],
        point: draft.point,
        strokes: draft.strokes.map((points) => ({ points, color: pencil })),
      }),
    ),
  );
  const capture = trackNoteCapture(
    projectId,
    saved.then(async ({ id }) => {
      const { framePath, captureError } = await captureReviewFrame(
        projectId,
        draft,
      );
      if (!framePath) return captureError;
      try {
        await api(
          `/projects/${projectId}/review/${id}/frame`,
          z.object({ ok: z.literal(true) }),
          json("PUT", { framePath }),
        );
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }),
  );
  const { id } = await saved;
  return { id, capture };
}

async function captureReviewFrame(projectId: string, draft: EditorReviewDraft) {
  // Marks are the human's yellow pencil on a dark casing, read from the tokens.
  const tokens = getComputedStyle(document.documentElement);
  const pencil = tokens.getPropertyValue("--human").trim();
  let framePath: string | undefined;
  let captureError = "";
  let image: ImageBitmap | undefined;
  try {
    const response = await fetch(frameCaptureUrl(projectId, draft));
    if (!response.ok)
      throw new Error(`Frame capture failed (${response.status}).`);
    image = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const paint = canvas.getContext("2d");
    if (!paint) throw new Error("The browser could not draw the frame.");
    paint.drawImage(image, 0, 0);
    const width = Math.max(3, image.width / 400);
    paint.lineCap = "round";
    paint.lineJoin = "round";
    for (const [style, lineWidth] of [
      [tokens.getPropertyValue("--pencil-casing").trim(), (width * 7) / 3],
      [pencil, width],
    ] as const) {
      paint.strokeStyle = style;
      paint.lineWidth = lineWidth;
      for (const points of draft.strokes)
        paint.stroke(new Path2D(strokePath(points, image.width, image.height)));
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
  return { framePath, captureError };
}
