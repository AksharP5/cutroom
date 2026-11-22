import { showSource } from "../edit/source";
import { clipMatteState, stopMatte, useMattes } from "../edit/mattes";
import { keepBackground } from "../edit/inspector/BackgroundRow";
import { useTimeline } from "../edit/timeline";

/** The running matte job, as an export shows there; clicking it selects its clip. */
export function MatteStatus({ projectId }: { projectId: string }) {
  const status = useMattes((state) => state.status);
  const view = useTimeline((state) => state.view);
  const job = status?.jobs.find(({ status }) => status === "running");
  if (!job || !view || !status) return null;
  const clip = view.timeline.clips.find(
    (clip) =>
      clipMatteState(status, view.composition, clip, view.timeline.fps)
        ?.state === "running",
  );
  const progress = Math.floor((job.done / job.frames) * 100);
  return (
    <span className="matte-job">
      <button
        type="button"
        disabled={!clip}
        onClick={() => {
          if (!clip) return;
          showSource(false);
          useTimeline.setState({
            selection: { ids: new Set([clip.id]), anchor: clip.id },
          });
        }}
      >
        Removing background {progress}%
      </button>
      <button
        type="button"
        className="text-button quiet"
        onClick={() => {
          void stopMatte(projectId, job.id);
          if (clip) void keepBackground(projectId, [clip]);
        }}
      >
        Stop
      </button>
    </span>
  );
}
