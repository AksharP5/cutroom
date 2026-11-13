import { z } from "zod";
import { AnnotationSchema } from "../../shared/project";
import { TimelineViewSchema } from "../../shared/timeline/schema";
import type { AnimationFeedbackSchema } from "../../shared/timeline/schema";
import { toSeconds } from "../../shared/timeline/apply";
import { api, json } from "../api";
import { showToast } from "../workspace";
import { queueNoteChange } from "./noteStore";

let dismiss = () => {};

export function dismissAnimationFeedback() {
  dismiss();
  dismiss = () => {};
}

export function showAnimationFeedback(
  projectId: string,
  feedback: z.infer<typeof AnimationFeedbackSchema>,
) {
  const first = feedback.clips[0];
  if (!first) return;
  const message =
    feedback.clips.length > 1
      ? `${feedback.clips.length} clips left their animation behind.`
      : `${first.label}'s animation stayed behind.`;
  dismissAnimationFeedback();
  dismiss = showToast(
    message,
    {
      label: "Ask agent",
      run: () => {
        dismiss();
        void queueNoteChange(projectId, async () => {
          const current = await api(
            `/projects/${projectId}/timeline?composition=${encodeURIComponent(feedback.composition)}`,
            TimelineViewSchema,
          );
          for (const warning of feedback.clips) {
            const clip = current.timeline.clips.find(
              (clip) => clip.id === warning.clipId,
            );
            if (!clip) continue;
            const start = toSeconds(clip.start, current.timeline.fps);
            await api(
              `/projects/${projectId}/annotations`,
              AnnotationSchema,
              json("POST", {
                kind: "comment",
                elementId: clip.id,
                time: start,
                compositionPath: feedback.composition,
                body: `Make this clip's animation follow the clip. Its root animation still uses composition time and the clip now starts at ${start.toFixed(2)} s. Move the title into its own sub-composition file with a timeline in clip-local seconds. Keep the look and the timing relative to the clip's start. Check the first second of the clip with timeline_view.`,
              }),
            );
          }
        }).catch((error: unknown) =>
          showToast(error instanceof Error ? error.message : String(error)),
        );
      },
    },
    { tone: "info", transient: true },
  );
}
