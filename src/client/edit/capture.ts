import { z } from "zod";
import { StillSchema } from "../../shared/export";
import { frameTime } from "../../shared/timeline/apply";
import { formatTimecode } from "../../shared/timeline/timecode";
import { showToast } from "../workspace";
import { useTimeline } from "./timeline";
import { useTransport } from "./transport";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Saves the frame at the playhead as a PNG at the composition's size, beside the project's
 * exports, and names the file in a toast.
 */
export async function captureFrame(projectId: string) {
  const { frame, fps } = useTransport.getState();
  const composition = useTimeline.getState().view?.composition ?? "index.html";
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/still`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          composition,
          time: frameTime(frame, fps),
          timecode: formatTimecode(frame, fps),
        }),
      },
    );
    const body: unknown = await response.json();
    if (!response.ok)
      throw new Error(
        z.object({ error: z.string() }).safeParse(body).data?.error ??
          `the server answered ${response.status}`,
      );
    const still = StillSchema.parse(body);
    const desktop = window.cutroomDesktop;
    showToast(
      `Saved ${still.filename} in .cutroom/renders`,
      desktop
        ? {
            label: "Reveal",
            run: () =>
              void desktop
                .reveal(still.path)
                .catch((error: unknown) => showToast(message(error))),
          }
        : null,
      { tone: "info" },
    );
  } catch (error) {
    showToast(`Frame capture failed: ${message(error)}`);
  }
}
