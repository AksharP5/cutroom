import { reportEditorError } from "../workspace";
import { audioLevels } from "./levels";
import {
  PreviewLevelsSchema,
  PlaybackClockSchema,
  PreviewReplySchema,
  RuntimeStateSchema,
} from "../../shared/preview";
import type { PlaybackClock, PreviewState } from "../../shared/preview";
import type { RuntimePlayer } from "./transport";

let positionTarget:
  ((clipId: string, x: number | null, y: number | null) => void) | null = null;
/** Drafts go only to the live document, never through timeline state or the server. */
export function previewPosition(
  clipId: string,
  x: number | null,
  y: number | null,
) {
  positionTarget?.(clipId, x, y);
}

/** Owns one frame's message requests and cached clock. It never reads the composition's DOM. */
export function connectPreview(frame: HTMLIFrameElement) {
  let state: PreviewState = {
    ready: false,
    root: false,
    error: null,
    width: 1920,
    height: 1080,
    fps: null,
    time: 0,
    playing: false,
  };
  const closing = new AbortController();
  let active = false;
  let clock: PlaybackClock | null = null;
  const pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void; timer: number }
  >();
  const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== frame.contentWindow) return;
    if (active) {
      const playback = PlaybackClockSchema.safeParse(event.data);
      if (playback.success) {
        clock = playback.data;
        return;
      }
      const levels = PreviewLevelsSchema.safeParse(event.data);
      if (levels.success) {
        audioLevels.publish(levels.data);
        return;
      }
    }
    const runtime = RuntimeStateSchema.safeParse(event.data);
    if (runtime.success) {
      state.time = runtime.data.currentTime;
      state.playing = runtime.data.isPlaying;
      return;
    }
    const parsed = PreviewReplySchema.safeParse(event.data);
    if (!parsed.success) return;
    const reply = parsed.data;
    state = reply.state;
    const id = reply.id;
    const request = id ? pending.get(id) : undefined;
    if (!id || !request) {
      if (active && reply.error)
        reportEditorError("viewer", new Error(reply.error));
      return;
    }
    pending.delete(id);
    clearTimeout(request.timer);
    if (reply.error) request.reject(new Error(reply.error));
    else request.resolve();
  };
  window.addEventListener("message", receive);
  const send = (action: string, payload: object = {}) => {
    const id = crypto.randomUUID();
    frame.contentWindow?.postMessage(
      { source: "cutroom-viewer", id, action, ...payload },
      "*",
    );
    return id;
  };
  const request = (action: string) =>
    new Promise<void>((resolve, reject) => {
      closing.signal.throwIfAborted();
      const id = send(action);
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error("The preview did not draw the frame in time."));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
    });
  const player: RuntimePlayer = {
    play: () => {
      clock = null;
      state.playing = true;
      send("play");
    },
    pause: () => {
      state.playing = false;
      send("pause");
    },
    seek: (time) => {
      state.time = time;
      send("seek", { time });
    },
    time: () => state.time,
    clock: () => clock,
    playing: () => state.playing,
    setMuted: (muted) => {
      send("mute", { muted });
    },
  };
  const position = (clipId: string, x: number | null, y: number | null) => {
    send("position", { clipId, x, y });
  };
  return {
    player,
    signal: closing.signal,
    activate() {
      active = true;
      positionTarget = position;
      send("meter", { enabled: true });
    },
    get state() {
      return state;
    },
    inspect: () => request("inspect"),
    painted: () => request("paint"),
    dispose() {
      if (positionTarget === position) positionTarget = null;
      closing.abort();
      send("meter", { enabled: false });
      if (active) audioLevels.publish({ l: 0, r: 0, playing: false });
      active = false;
      window.removeEventListener("message", receive);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(closing.signal.reason);
      }
      pending.clear();
    },
  };
}
