import { sameRate } from "../../shared/projectFormat";
import { frames, nearestFrame } from "../../shared/timeline/piece";
import { create } from "zustand";
import { frameTime } from "../../shared/timeline/apply";
import type { Fps, Timeline } from "../../shared/timeline/schema";
import type { PlaybackClock } from "../../shared/preview";

export type Direction = "forward" | "reverse";
/** Half speed is K held with J or L; the rest are J and L pressed again. */
export type Speed = 0.5 | 1 | 2 | 4 | 8;
export type TransportState =
  | { kind: "stopped" }
  | { kind: "playing" }
  | { kind: "shuttle"; dir: Direction; speed: Speed }
  | { kind: "scrubbing" };
export type TransportEvent =
  /** L or 4 forward, J or 3 reverse; `fast` is Shift. */
  | { type: "shuttle"; dir: Direction; fast: boolean }
  /** K held with J or L held: half speed that way. */
  | { type: "slow"; dir: Direction }
  | { type: "toggle" }
  | { type: "stop" }
  | { type: "scrub" }
  | { type: "release" };

const stopped: TransportState = { kind: "stopped" };
type Hold = false | "saving" | "saved";
const doubled: Record<Speed, Speed> = { 0.5: 1, 1: 2, 2: 4, 4: 8, 8: 8 };

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
    case "slow":
      return { kind: "shuttle", dir: event.dir, speed: 0.5 };
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
  /**
   * Shows the frame at `seconds`. While the playhead is `moving` (a scrub or shuttle), a player
   * may show a quicker stand-in picture first, as long as the exact frame replaces it at rest.
   */
  seek(seconds: number, moving?: boolean): void;
  /** Seconds on the runtime's own clock, which leads at 1x so audio stays in sync. */
  time(at?: DOMHighResTimeStamp): number;
  /** Continuous playback time paired with the instant it was observed in the preview. */
  clock(): PlaybackClock | null;
  /** False once the runtime stops by itself at the end of the composition. */
  playing(): boolean;
  setMuted(muted: boolean): void;
}

/** What a transport plays: a timeline, or one source file. */
export type Playable = Pick<Timeline, "fps" | "duration" | "range">;

/**
 * A playhead over one thing that plays. React reads `state`, `loop`, and `muted` through `use`;
 * anything that follows the frame (playhead, timecode) subscribes with `use.subscribe` and writes
 * to the DOM directly.
 */
export function createTransport() {
  const use = create(() => ({
    state: stopped as TransportState,
    frame: 0,
    fps: { num: 30, den: 1 } as Fps,
    /** Frames in what plays; the last frame is `duration - 1`. */
    duration: 0,
    /** In and out marks; out is exclusive. */
    range: { in: null, out: null } as Timeline["range"],
    loop: false,
    /** A span that playback loops over in place of the marks, such as a clip being auditioned. */
    span: null as { first: number; end: number } | null,
    muted: false,
    /**
     * The playhead last moved with an edit, and the documents from before the edit still show
     * the frame they showed. Until the edit is `saved`, anything read from disk can predate it
     * too. Any playback or seek paints the playhead's frame again.
     */
    held: false as Hold,
    /** Counts frame steps, so a step's sound can follow it. */
    steps: 0,
  }));

  const get = use.getState;
  const set = use.setState;
  let player: RuntimePlayer | null = null;
  let tick = 0;
  let follows = 0;
  let origin = { frame: 0, at: 0 };
  /** One pass of Play Around: plays `first` to `end`, then the playhead goes back to `back`. */
  let around: { first: number; end: number; back: number } | null = null;

  const clamp = (frame: number) =>
    Math.max(0, Math.min(get().duration - 1, frame));
  const show = (frame: number) => {
    const { state, fps } = get();
    player?.seek(
      frameTime(frame, fps),
      state.kind === "scrubbing" || state.kind === "shuttle",
    );
  };
  /** The frame on screen at a runtime time. */
  const frameAt = (seconds: number) => {
    const { fps } = get();
    return Math.floor((seconds * fps.num) / fps.den + 1e-6);
  };

  /** Playback wraps inside the range while loop is on, and otherwise runs the whole length. */
  function bounds() {
    const { loop, range, duration, span } = get();
    if (around) return around;
    if (span) return { first: span.first, end: Math.min(span.end, duration) };
    return loop
      ? { first: range.in ?? 0, end: Math.min(range.out ?? duration, duration) }
      : { first: 0, end: duration };
  }

  function park(frame: number, held: Hold = false) {
    around = null;
    cancelAnimationFrame(tick);
    player?.pause();
    set({ state: stopped, frame, held });
    if (!held) show(frame);
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
        ? frameAt(player.time(now))
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
    const loops = get().loop || get().span !== null;
    // Loop repeats Play Around, as in Resolve; otherwise one pass returns the playhead.
    if (frame >= end && around && !get().loop) return park(clamp(around.back));
    if (frame >= end) {
      if (loops) restart(first);
      else return park(end - 1);
    } else if (frame < first) {
      if (loops) restart(end - 1);
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
    set({ state: next, frame, held: false });
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
    if (player) tick = requestAnimationFrame(advance);
  }

  const transport = {
    use,
    clock: () => player?.clock() ?? null,
    /**
     * Where a shuttle's playhead is at page time `at`, in frames between whole ones; the frame
     * shown is this rounded toward the start. Null unless shuttling.
     */
    shuttlePosition(at: number) {
      const { state, fps } = get();
      if (state.kind !== "shuttle") return null;
      return (
        origin.frame +
        (((at - origin.at) / 1000) * velocity(state) * fps.num) / fps.den
      );
    },
    dispatch(event: TransportEvent) {
      around = null;
      run(transition(get().state, event));
    },
    /**
     * Plays `first` to `end` once and puts the playhead back where it was, as Resolve's Play
     * Around does, or over and over while Loop is on. Pressed again during a pass, it plays
     * that pass again from its start. Any other playback or seek ends it where it is.
     */
    playAround(first: number, end: number) {
      const { frame, duration } = get();
      if (!duration) return;
      const pass = around ?? {
        first: clamp(first),
        end: Math.min(Math.max(end, first + 1), duration),
        back: frame,
      };
      park(pass.first);
      around = pass;
      run({ kind: "playing" });
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
    /**
     * Moves the playhead with an edit, such as Q's ripple trim or a placement, and stops.
     * The document on screen predates the edit, so any other frame of it can be the wrong
     * picture: it keeps the one it shows until the edited document draws the new frame.
     * Call the returned function once the server has answered the edit.
     */
    follow(frame: number) {
      const id = ++follows;
      park(clamp(frame), "saving");
      return () => {
        if (id === follows && get().held === "saving") set({ held: "saved" });
      };
    },
    step(frames: number) {
      transport.seek(get().frame + frames);
      set({ steps: get().steps + 1 });
    },
    /** Seeks while a pointer drags the playhead; `release` ends it. */
    scrub(frame: number) {
      if (get().state.kind !== "scrubbing")
        transport.dispatch({ type: "scrub" });
      transport.seek(frame);
    },
    release() {
      transport.dispatch({ type: "release" });
    },
    toggleLoop() {
      set({ loop: !get().loop });
    },
    /** Loops playback over `span` until it is cleared with null; the marks stay as they are. */
    loopSpan(span: { first: number; end: number } | null) {
      set({ span });
    },
    toggleMute() {
      set({ muted: !get().muted });
      player?.setMuted(get().muted);
    },
    /** Takes the frame rate, length, and marks; keeps the playhead inside the new length. */
    setTimeline({ fps, duration, range }: Playable) {
      const before = get();
      if (!sameRate(before.fps, fps)) {
        const snap = (frame: number) =>
          Number(nearestFrame(frames(frame, before.fps), fps));
        set({ fps, duration, range, span: null });
        transport.seek(snap(before.frame));
        return;
      }
      if (around && around.end > duration) around.end = duration;
      set({ fps, duration, range });
      if (get().frame >= duration) transport.seek(duration - 1);
    },
    /** The document is gone. Keep the latest playback intent until its replacement attaches. */
    suspend() {
      cancelAnimationFrame(tick);
      player = null;
    },
    /**
     * Hands the playhead to a newly loaded player, which already shows frame `shown`. While
     * the playhead is held, a document from before the edit keeps that frame.
     */
    attach(next: RuntimePlayer | null, shown?: number) {
      player?.pause();
      player = next;
      if (!next) return park(get().frame);
      next.setMuted(get().muted);
      const { state, frame, held } = get();
      if (velocity(state) || (shown !== frame && !held)) restart(frame);
      if (velocity(state)) {
        cancelAnimationFrame(tick);
        tick = requestAnimationFrame(advance);
      }
    },
  };
  return transport;
}
export type Transport = ReturnType<typeof createTransport>;

/** The timeline's playhead. */
export const transport = createTransport();
export const useTransport = transport.use;
