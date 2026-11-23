import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import type { Clip, Fps } from "../../../shared/timeline/schema";
import {
  sourceOutFrame,
  speedAtFrame,
  speedLevel,
  speedPoints,
} from "../../../shared/timeline/speed";
import type { SpeedPoint } from "../../../shared/timeline/speed";
import { TimecodeText } from "../../components/TimecodeText";
import { formatTimecode } from "../../../shared/timeline/timecode";
import { speedPath } from "../../timeline/ClipSpeed";
import { useTransport } from "../transport";
import { ValueField } from "./ValueField";

const GRID = [4, 2, 1, 0.5, 0.25];

/** The read-only source Out: the last source frame the clip plays, which a ramp moves. */
export function SourceOut({ clip, fps }: { clip: Clip; fps: Fps }) {
  const out = sourceOutFrame(clip, fps);
  if (out === null) return null;
  return (
    <div
      className="inspector-cell inspector-net"
      title="The last source frame the clip plays"
    >
      <span aria-hidden="true">Out</span>
      <output aria-label="Source out" className="mono">
        <TimecodeText timecode={formatTimecode(out, fps)} />
      </output>
    </div>
  );
}

/** The playhead's clip-local frame, or null outside the clip. Renders only for a ramped clip. */
function usePlayheadIn(clip: Clip, follow: boolean) {
  return useTransport(({ frame }) => {
    if (!follow) return null;
    const local = frame - clip.start;
    return local >= 0 && local < clip.duration ? local : null;
  });
}

/**
 * Speed in Timing, with the ramp's graph under it once the clip has points. A constant speed is
 * typed here as before; a ramp shows its speed at the playhead, or at the clip's first frame
 * while the playhead is outside it.
 */
export function SpeedRows({
  clip,
  fps,
  disabled,
  onSpeed,
}: {
  clip: Clip;
  fps: Fps;
  disabled: boolean | undefined;
  onSpeed(value: number | null): void;
}) {
  const points = speedPoints(clip, fps);
  const local = usePlayheadIn(clip, points !== null);
  if (!points)
    return (
      <ValueField
        key={`${clip.id}:speed`}
        label="Speed"
        value={clip.playbackRate}
        initial={1}
        unit="percent"
        min={MIN_PLAYBACK_RATE}
        max={MAX_PLAYBACK_RATE}
        fps={fps}
        disabled={disabled}
        onReset={() => onSpeed(1)}
        onCommit={onSpeed}
      />
    );
  const speed = speedAtFrame(clip, fps, local ?? 0);
  return (
    <>
      <ValueField
        key={`${clip.id}:ramp`}
        label="Speed"
        value={Math.round(speed * 1e4) / 1e4}
        unit="percent"
        fps={fps}
        disabled
        tip={`Speed ${Math.round(speed * 100)}% ${local === null ? "at the clip's first frame" : "at the playhead"}`}
        onCommit={() => {}}
      />
      <SpeedGraph clip={clip} fps={fps} points={points} playhead={local} />
    </>
  );
}

/** The clip's whole length, speed on a log scale from 10% to 1000%, whatever the timeline zoom. */
function SpeedGraph({
  clip,
  fps,
  points,
  playhead,
}: {
  clip: Clip;
  fps: Fps;
  points: readonly SpeedPoint[];
  playhead: number | null;
}) {
  const at = (frame: number) => `${(frame / clip.duration) * 100}%`;
  const level = (speed: number) => `${speedLevel(speed) * 100}%`;
  return (
    <div className="speed-graph" role="img" aria-label="Speed over the clip">
      {GRID.map((speed) => (
        <span
          key={speed}
          className="speed-label"
          style={{ "--level-fraction": speedLevel(speed) }}
        >
          {speed * 100}
        </span>
      ))}
      <div className="speed-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {GRID.map((speed) => (
            <line
              key={speed}
              className={speed === 1 ? "unity" : undefined}
              x1="0"
              x2="100"
              y1={speedLevel(speed) * 100}
              y2={speedLevel(speed) * 100}
            />
          ))}
          <path className="speed-line" d={speedPath(clip, fps)} />
          {playhead !== null && (
            <line
              className="speed-playhead"
              x1={(playhead / clip.duration) * 100}
              x2={(playhead / clip.duration) * 100}
              y1="-6"
              y2="106"
            />
          )}
        </svg>
        {points.map((point, index) => (
          <i
            key={index}
            className="speed-point"
            data-ease={point.ease}
            data-on={point.frame === playhead ? "" : undefined}
            hidden={point.frame < 0 || point.frame > clip.duration}
            style={{ "--at": at(point.frame), "--level": level(point.speed) }}
          />
        ))}
      </div>
    </div>
  );
}
