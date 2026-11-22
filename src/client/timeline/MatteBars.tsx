import { memo } from "react";
import type { Clip, Timeline } from "../../shared/timeline/schema";
import { clipMatteState, useMattes } from "../edit/mattes";

/**
 * Along the foot of each clip whose matte is being made, the frames already done. A ready matte,
 * and a clip that keeps its background, draw nothing. Only this subscribes to job progress, so the
 * timeline itself never renders for it.
 */
export const MatteBars = memo(function MatteBars({
  clips,
  timeline,
  composition,
}: {
  clips: readonly Clip[];
  timeline: Timeline;
  composition: string;
}) {
  const status = useMattes((state) => state.status);
  return clips.flatMap((clip) => {
    const matte = clipMatteState(status, composition, clip, timeline.fps);
    if (!matte || matte.state === "ready" || matte.state === "no-subject")
      return [];
    const grid =
      status?.mattes.find(({ src }) => src === matte.src) ??
      status?.jobs.find(({ src }) => src === matte.src);
    if (!grid) return [];
    // Source frames back to the clip's own frames, as its rate plays them.
    const toClip = (frame: number) =>
      (((grid.start + frame / grid.rate - matte.from) / clip.playbackRate) *
        timeline.fps.num) /
      timeline.fps.den;
    return matte.done.map(([first, end]) => {
      const start = Math.max(0, toClip(first));
      const stop = Math.min(clip.duration, toClip(end));
      return (
        <i
          key={`${clip.id}:${first}`}
          className="matte-progress"
          data-matte-progress={clip.id}
          style={{
            "--s": clip.start + start,
            "--d": Math.max(0, stop - start),
            "--done": 1,
          }}
        />
      );
    });
  });
});
