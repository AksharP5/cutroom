import { create } from "zustand";
import { frameTime } from "../../shared/timeline/apply";
import type { Fps, Timeline } from "../../shared/timeline/schema";
import type { PlaybackClock } from "../../shared/preview";

export type Direction = "forward" | "reverse";
export type Speed = 1 | 2 | 4 | 8;
export type TransportState =
  | { kind: "stopped" }
  | { kind: "playing" }
  | { kind: "shuttle"; dir: Direction; speed: Speed }
  | { kind: "scrubbing" };
export type TransportEvent =
  /** L or 4 forward, J or 3 reverse; `fast` is Shift. */
  | { type: "shuttle"; dir: Direction; fast: boolean }
  | { type: "toggle" }
  | { type: "stop" }
  | { type: "scrub" }
  | { type: "release" };

const stopped: TransportState = { kind: "stopped" };
const doubled: Record<Speed, Speed> = { 1: 2, 2: 4, 4: 8, 8: 8 };

/**
 * Resolve's shuttle: each press in the playing direction doubles the speed up to 8x, the other
 * direction drops to 1x, and Shift starts at 4x. Plain 1x forward is `playing`, never a shuttle.
 */
export function transition(
  state: TransportState,
  event: TransportEvent,
): TransportState {
  switch (event.type) {
    case "stop":
      return stopped;
    case "toggle":
      return state.kind === "stopped" ? { kind: "playing" } : stopped;
    case "scrub":
      return { kind: "scrubbing" };
    case "release":
      return state.kind === "scrubbing" ? stopped : state;
    case "shuttle": {
      const moving =
        state.kind === "playing"
          ? { dir: "forward", speed: 1 as Speed }
          : state.kind === "shuttle"
            ? state
            : null;
      const next =
        moving?.dir === event.dir ? doubled[moving.speed] : (1 as Speed);
      const speed = event.fast && next < 4 ? 4 : next;
      return event.dir === "forward" && speed === 1
        ? { kind: "playing" }
        : { kind: "shuttle", dir: event.dir, speed };
    }
  }
}

/** Timeline frames per real frame: negative in reverse, zero when still. */
export function velocity(state: TransportState): number {
  if (state.kind === "playing") return 1;
  if (state.kind !== "shuttle") return 0;
  return state.dir === "forward" ? state.speed : -state.speed;
}

/** The HyperFrames runtime inside the live preview frame. */
export interface RuntimePlayer {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  /** Seconds on the runtime's own clock, which leads at 1x so audio stays in sync. */
  time(): number;
  /** Continuous playback time paired with the instant it was observed in the preview. */
  clock(): PlaybackClock | null;
  /** False once the runtime stops by itself at the end of the composition. */
  playing(): boolean;
  setMuted(muted: boolean): void;
}

/**
 * The one playhead. React reads `state`, `loop`, and `muted`; anything that follows the frame
 * (playhead, timecode) subscribes with `useTransport.subscribe` and writes to the DOM directly.
 */
export const useTransport = create(() => ({
  state: stopped as TransportState,
  frame: 0,
  fps: { num: 30, den: 1 } as Fps,
  /** Frames in the timeline; the last frame is `duration - 1`. */
  duration: 0,
  /** In and out marks; out is exclusive. */
  range: { in: null, out: null } as Timeline["range"],
  loop: false,
  muted: false,
}));

const get = useTransport.getState;
const set = useTransport.setState;
let player: RuntimePlayer | null = null;
let tick = 0;
let origin = { frame: 0, at: 0 };

const clamp = (frame: number) =>
  Math.max(0, Math.min(get().duration - 1, frame));
const show = (frame: number) => player?.seek(frameTime(frame, get().fps));
/** The frame on screen at a runtime time. */
const frameAt = (seconds: number) => {
  const { fps } = get();
  return Math.floor((seconds * fps.num) / fps.den + 1e-6);
};

/** Playback wraps inside the range while loop is on, and otherwise runs the whole timeline. */
function bounds() {
  const { loop, range, duration } = get();
  return loop
    ? { first: range.in ?? 0, end: Math.min(range.out ?? duration, duration) }
    : { first: 0, end: duration };
}

function park(frame: number) {
  cancelAnimationFrame(tick);
  player?.pause();
  set({ state: stopped, frame });
  show(frame);
}

function restart(frame: number) {
  origin = { frame, at: performance.now() };
  set({ frame });
  show(frame);
  if (get().state.kind === "playing") player?.play();
}

function advance(now: number) {
  const { state, fps } = get();
  const speed = velocity(state);
  if (!speed) return;
  const { first, end } = bounds();
  // At 1x the runtime plays its media and its clock leads; shuttles step frames on ours.
  let frame =
    state.kind === "playing" && player
      ? frameAt(player.time())
      : origin.frame +
        Math.trunc((((now - origin.at) / 1000) * speed * fps.num) / fps.den);
  // At 23.976 and 29.97 the runtime's end time floors to the last frame, one short of the
  // engine's exclusive end, so the runtime stopping by itself there is the end.
  if (
    state.kind === "playing" &&
    player &&
    !player.playing() &&
    frame >= end - 1
  )
    frame = end;
  if (frame >= end) {
    if (get().loop) restart(first);
    else return park(end - 1);
  } else if (frame < first) {
    if (get().loop) restart(end - 1);
    else return park(first);
  } else if (frame !== get().frame) {
    set({ frame });
    if (state.kind !== "playing") show(frame);
  }
  tick = requestAnimationFrame(advance);
}

function run(next: TransportState) {
  if (!get().duration) return;
  const previous = get().state;
  cancelAnimationFrame(tick);
  player?.pause();
  // The runtime's clock runs between frames at 1x; settle on the frame it reached, exactly.
  const frame =
    previous.kind === "playing" && player
      ? clamp(frameAt(player.time()))
      : get().frame;
  set({ state: next, frame });
  const speed = velocity(next);
  if (!speed) {
    show(frame);
    return;
  }
  const { first, end } = bounds();
  // Playing forward from the last frame starts over; outside a looped range, play enters it.
  const start =
    frame >= first && frame < end
      ? speed > 0 && frame === end - 1
        ? first
        : frame
      : speed > 0
        ? first
        : end - 1;
  restart(start);
  tick = requestAnimationFrame(advance);
}

export const transport = {
  clock: () => player?.clock() ?? null,
  dispatch(event: TransportEvent) {
    run(transition(get().state, event));
  },
  /** Moves the playhead and stops playback; the latest seek wins. */
  seek(frame: number) {
    if (get().state.kind === "scrubbing") {
      set({ frame: clamp(frame) });
      show(get().frame);
      return;
    }
    park(clamp(frame));
  },
  step(frames: number) {
    transport.seek(get().frame + frames);
  },
  /** Seeks while a pointer drags the playhead; `release` ends it. */
  scrub(frame: number) {
    if (get().state.kind !== "scrubbing") transport.dispatch({ type: "scrub" });
    transport.seek(frame);
  },
  release() {
    transport.dispatch({ type: "release" });
  },
  toggleLoop() {
    set({ loop: !get().loop });
  },
  toggleMute() {
    set({ muted: !get().muted });
    player?.setMuted(get().muted);
  },
  /** Takes the engine's frame rate, length, and marks; keeps the playhead inside the new length. */
  setTimeline({ fps, duration, range }: Timeline) {
    set({ fps, duration, range });
    if (get().frame >= duration) transport.seek(duration - 1);
  },
  /** Hands the playhead to a newly loaded preview, which already shows frame `shown`. */
  attach(next: RuntimePlayer | null, shown?: number) {
    player?.pause();
    player = next;
    if (!next) return park(get().frame);
    next.setMuted(get().muted);
    const { state, frame } = get();
    if (velocity(state) || shown !== frame) restart(frame);
  },
};
