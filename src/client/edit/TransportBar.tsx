import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import {
  CornersIn,
  CornersOut,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerSlash,
  Stop,
} from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import {
  VoiceoverTransport,
  VoiceoverRecordMark,
} from "../voiceover/Voiceover";
import type { VoiceoverSession } from "../voiceover/session";
import { hint } from "../keymap";
import {
  formatTimecode,
  parseTimecode,
  timecodeDigits,
} from "../../shared/timeline/timecode";
import { transport, useTransport, velocity } from "./transport";

/** Writes the frame-driven parts of the bar straight to the DOM on every frame, without React. */
function useFrameText(
  write: (state: ReturnType<typeof useTransport.getState>) => void,
) {
  const latest = useRef(write);
  latest.current = write;
  useEffect(() => {
    latest.current(useTransport.getState());
    return useTransport.subscribe((state, previous) => {
      if (
        state.frame !== previous.frame ||
        state.fps !== previous.fps ||
        state.duration !== previous.duration
      )
        latest.current(state);
    });
  }, []);
}

function Timecode({ voiceover }: { voiceover: VoiceoverSession }) {
  const head = useRef<HTMLSpanElement>(null);
  const frames = useRef<HTMLSpanElement>(null);
  const [digits, setDigits] = useState<string | null>(null);
  const fps = useTransport((state) => state.fps);
  const duration = useTransport((state) => state.duration);
  useFrameText(({ frame, fps }) => {
    if (!head.current || !frames.current) return;
    const text = formatTimecode(frame, fps);
    head.current.textContent = text.slice(0, 9);
    frames.current.textContent = text.slice(9);
  });

  const finish = (seek: boolean) => {
    const frame = seek && digits ? parseTimecode(digits, fps) : null;
    setDigits(null);
    if (frame !== null) transport.seek(frame);
  };

  return (
    <div className="edit-timecode">
      {/* Stays mounted while typing, so the frame writes always land. */}
      <button
        className="edit-now"
        aria-label="Current time. Click to type a time."
        title="Type a time"
        hidden={digits !== null}
        onClick={() => setDigits("")}
      >
        <span ref={head} />
        <span ref={frames} className="edit-now-frames" />
      </button>
      {digits !== null && (
        <input
          className="edit-now"
          aria-label="Go to time"
          autoFocus
          readOnly
          value={(timecodeDigits(digits).match(/\d\d/g) ?? []).join(":")}
          onBlur={() => finish(false)}
          onKeyDown={(event) => {
            if (/^\d$/.test(event.key)) setDigits(digits + event.key);
            else if (event.key === "Backspace") setDigits(digits.slice(0, -1));
            else if (event.key === "Enter") finish(true);
            else if (event.key === "Escape") finish(false);
            else return;
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      )}
      <span className="edit-duration">{formatTimecode(duration, fps)}</span>
      {/* After the clock, so starting a take never moves the timecode. */}
      <VoiceoverRecordMark session={voiceover} />
    </div>
  );
}

/** Fullscreen only: a thin scrub track with the range shaded. */
function ScrubTrack() {
  const playhead = useRef<HTMLSpanElement>(null);
  const { duration, range } = useTransport(
    useShallow(({ duration, range }) => ({ duration, range })),
  );
  useFrameText(({ frame, duration }) => {
    if (playhead.current)
      playhead.current.style.transform = `translateX(${(frame / Math.max(1, duration)) * 100}cqw)`;
  });
  const scrub = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    transport.scrub(
      Math.floor(((event.clientX - bounds.left) / bounds.width) * duration),
    );
  };
  const share = (frame: number) => `${(frame / Math.max(1, duration)) * 100}%`;
  return (
    <div
      className="edit-scrub"
      role="slider"
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={duration}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        scrub(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          scrub(event);
      }}
      onPointerUp={() => transport.release()}
      onPointerCancel={() => transport.release()}
    >
      {(range.in !== null || range.out !== null) && (
        <span
          className="edit-scrub-range"
          style={{
            left: share(range.in ?? 0),
            right: `calc(100% - ${share(range.out ?? duration)})`,
          }}
        />
      )}
      <span ref={playhead} className="edit-scrub-head" />
    </div>
  );
}

export function TransportBar({
  voiceover,
  fullscreen,
  onFullscreen,
}: {
  voiceover: VoiceoverSession;
  fullscreen: boolean;
  onFullscreen: () => void;
}) {
  // Everything but the frame, so playback does not re-render the bar.
  const { state, range, fps, loop, muted, duration } = useTransport(
    useShallow(({ frame: _, ...rest }) => rest),
  );
  const speed = velocity(state);
  const shuttle =
    state.kind === "shuttle"
      ? `${state.dir === "reverse" ? "-" : ""}${state.speed}x`
      : "";
  return (
    <>
      {fullscreen && <ScrubTrack />}
      <div className="edit-transport" aria-label="Transport">
        <Timecode voiceover={voiceover} />
        <div className="edit-transport-controls">
          <span className="edit-shuttle" />
          <button
            className="edit-icon"
            aria-label="First frame"
            title={hint("controlFirstFrame")}
            onClick={() => transport.seek(0)}
          >
            <SkipBack size={16} />
          </button>
          <button
            className="edit-icon"
            aria-label="Play reverse"
            aria-pressed={speed < 0}
            title={hint("controlPlayReverse")}
            onClick={() =>
              transport.dispatch({
                type: "shuttle",
                dir: "reverse",
                fast: false,
              })
            }
          >
            <Play
              size={16}
              weight={speed < 0 ? "fill" : "regular"}
              className="edit-mirrored"
            />
          </button>
          <button
            className="edit-icon"
            aria-label="Stop"
            aria-pressed={state.kind === "stopped"}
            title={hint("controlStop")}
            onClick={() => transport.dispatch({ type: "stop" })}
          >
            <Stop size={14} weight="fill" />
          </button>
          <button
            className="edit-icon"
            aria-label="Play forward"
            aria-pressed={speed > 0}
            title={hint("controlPlayForward")}
            onClick={() =>
              transport.dispatch({
                type: "shuttle",
                dir: "forward",
                fast: false,
              })
            }
          >
            <Play size={16} weight={speed > 0 ? "fill" : "regular"} />
          </button>
          <button
            className="edit-icon"
            aria-label="Last frame"
            title={hint("controlLastFrame")}
            onClick={() => transport.seek(duration - 1)}
          >
            <SkipForward size={16} />
          </button>
          <VoiceoverTransport session={voiceover} />
          <span className="edit-shuttle" aria-label="Shuttle speed">
            {shuttle}
          </span>
        </div>
        <div className="edit-transport-end">
          {(range.in !== null || range.out !== null) && (
            <span className="edit-range">
              {range.in !== null && (
                <>
                  <span>In</span> {formatTimecode(range.in, fps)}
                </>
              )}
              {range.out !== null && (
                <>
                  <span>Out</span> {formatTimecode(range.out - 1, fps)}
                </>
              )}
            </span>
          )}
          <button
            className="edit-icon"
            aria-label="Mute"
            aria-pressed={muted}
            title="Mute"
            onClick={() => transport.toggleMute()}
          >
            {muted ? <SpeakerSlash size={16} /> : <SpeakerHigh size={16} />}
          </button>
          <button
            className="edit-icon"
            aria-label="Loop"
            aria-pressed={loop}
            title={hint("controlLoop")}
            onClick={() => transport.toggleLoop()}
          >
            <Repeat size={16} weight={loop ? "fill" : "regular"} />
          </button>
          <button
            className="edit-icon"
            aria-label="Fullscreen"
            aria-pressed={fullscreen}
            title={hint("workspaceViewerModeCinemaViewer")}
            onClick={onFullscreen}
          >
            {fullscreen ? <CornersIn size={16} /> : <CornersOut size={16} />}
          </button>
        </div>
      </div>
    </>
  );
}
