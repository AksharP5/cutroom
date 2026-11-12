import { createStore } from "zustand/vanilla";
import { z } from "zod";
import { frameTime } from "../../shared/timeline/apply";
import type { Track } from "../../shared/timeline/schema";
import { newTrack, nextTrackIndex } from "../../shared/timeline/tracks";
import { voiceoverCommands, voiceoverTrack } from "../../shared/voiceover";
import {
  afterTimelineEdits,
  editTimeline,
  useTimeline,
} from "../edit/timeline";
import { transport, useTransport } from "../edit/transport";
import { showToast, useWorkspace } from "../workspace";
import { microphoneError, openMicrophone } from "./capture";

type Take = {
  blob: Blob;
  start: number;
  duration: number;
  file: string | null;
  droppedMs: number;
};
type State =
  | { kind: "idle" }
  | { kind: "arming" | "armed" | "saving"; track: Track }
  | {
      kind: "recording";
      track: Track;
      start: number;
      loop: boolean;
    }
  | { kind: "save-failed"; track: Track; take: Take };

// Releasing a device cannot resolve a take. Only saving or explicit discard can.
const transitions = {
  idle: { arm: ["arming"], release: ["idle"], dispose: ["idle"] },
  arming: {
    arm: ["arming"],
    ready: ["armed"],
    trackRemoved: ["idle"],
    release: ["idle"],
    dispose: ["idle"],
  },
  armed: {
    arm: ["arming"],
    record: ["recording"],
    trackRemoved: ["idle"],
    release: ["idle"],
    dispose: ["idle"],
  },
  recording: { stop: ["saving"], dispose: ["idle"] },
  saving: {
    save: ["saving"],
    settle: ["armed", "idle"],
    failed: ["save-failed"],
    dispose: ["idle"],
  },
  "save-failed": {
    save: ["saving"],
    settle: ["armed", "idle"],
    dispose: ["idle"],
  },
} as const satisfies Record<
  State["kind"],
  Record<string, readonly State["kind"][]>
>;
type Transition = {
  [Kind in keyof typeof transitions]: keyof (typeof transitions)[Kind];
}[keyof typeof transitions];

const UploadSchema = z.object({ files: z.array(z.string()).length(1) });
const DEVICE_KEY = "cutroom.voiceover.input";

/** One project owns one armed microphone. Audio samples and meter updates stay outside React. */
export function createVoiceoverSession(projectId: string) {
  const store = createStore(() => ({
    state: { kind: "idle" } as State,
    devices: [] as MediaDeviceInfo[],
    device: localStorage.getItem(DEVICE_KEY) ?? "",
    inputLatency: null as number | null,
    compensation: 0,
    error: "",
    discard: null as "recording" | "unsaved" | null,
  }));
  const get = store.getState;
  const set = store.setState;
  const transition = (event: Transition, state: State) => {
    const from = get().state.kind;
    const allowed: Partial<Record<Transition, readonly State["kind"][]>> =
      transitions[from];
    if (!allowed[event]?.includes(state.kind))
      throw new Error(
        `Invalid voiceover transition: ${from} / ${event} / ${state.kind}`,
      );
    set({ state });
  };
  const settle = (track: Track) =>
    transition(
      "settle",
      microphone ? { kind: "armed", track } : { kind: "idle" },
    );
  let microphone: Awaited<ReturnType<typeof openMicrophone>> | null = null;
  let generation = 0;
  let disposed = false;
  let maxLength = 0;
  let stopTimeline = () => {};
  let stopTransport = () => {};
  let limit: number | undefined;
  let peak = 0;
  const meters = new Set<(peak: number) => void>();
  let closing = new AbortController();
  const level = (next: number) => {
    peak = next;
    meters.forEach((listener) => listener(next));
  };
  let dismissToast = () => {};
  const notify = (message: string, tone: "error" | "info" = "error") => {
    dismissToast = showToast(message, null, { tone });
  };
  const clearMessage = () => {
    dismissToast();
    set({ error: "" });
  };
  let resolveDiscard: ((discard: boolean) => void) | null = null;
  const confirmDiscard = (discard: "recording" | "unsaved") => {
    set({ discard });
    return new Promise<boolean>((resolve) => {
      resolveDiscard = resolve;
    });
  };
  const answerDiscard = (discard: boolean) => {
    const resolve = resolveDiscard;
    resolveDiscard = null;
    set({ discard: null });
    resolve?.(discard);
  };
  const fail = (error: unknown) => {
    if (!disposed) {
      const message = microphoneError(error);
      set({ error: message });
      notify(message);
    }
  };
  const refreshDevices = async () => {
    const devices = await navigator.mediaDevices?.enumerateDevices();
    if (!disposed)
      set({
        devices:
          devices?.filter((device) => device.kind === "audioinput") ?? [],
      });
  };
  const clearRecording = () => {
    stopTransport();
    stopTransport = () => {};
    clearTimeout(limit);
  };

  async function arm(track: Track, device = get().device) {
    if (["recording", "saving", "save-failed"].includes(get().state.kind))
      return;
    releaseMicrophone();
    const attempt = generation;
    if (track.locked || track.kind !== "audio") {
      transition("release", { kind: "idle" });
      set({ error: "Unlock an audio track before arming it." });
      return;
    }
    transition("arm", { kind: "arming", track });
    clearMessage();
    try {
      const opened = await openMicrophone(device, level, () => {
        void (async () => {
          if (disposed || attempt !== generation) return;
          if (get().state.kind === "recording") await stop();
          if (disposed || attempt !== generation) return;
          releaseMicrophone();
          if (["arming", "armed"].includes(get().state.kind))
            transition("release", { kind: "idle" });
          fail(
            new Error(
              "The microphone disconnected. Reconnect it and arm the track again.",
            ),
          );
        })();
      });
      if (disposed || attempt !== generation) {
        opened.close();
        return;
      }
      microphone = opened;
      localStorage.setItem(DEVICE_KEY, opened.deviceId);
      transition("ready", { kind: "armed", track });
      clearMessage();
      set({
        device: opened.deviceId,
        inputLatency: opened.inputLatency,
        compensation: opened.compensation,
      });
      await refreshDevices().catch(fail);
    } catch (error) {
      if (attempt !== generation || disposed) return;
      releaseMicrophone();
      transition("release", { kind: "idle" });
      fail(error);
      await refreshDevices().catch(fail);
    }
  }

  function releaseMicrophone() {
    ++generation;
    clearRecording();
    microphone?.close();
    microphone = null;
  }

  function disarm() {
    releaseMicrophone();
    transition("release", { kind: "idle" });
    clearMessage();
  }

  async function start() {
    const armed = get().state;
    if (armed.kind !== "armed" || !microphone) return;
    try {
      await afterTimelineEdits(projectId, async () => {
        if (disposed || get().state !== armed || !microphone) return;
        const view = useTimeline.getState().view;
        const current =
          view?.timeline.tracks.find(
            (track) => track.index === armed.track.index,
          ) ?? armed.track;
        if (current.locked || current.kind !== "audio")
          throw new Error("Unlock an audio track before recording.");
        transport.dispatch({ type: "stop" });
        const { frame, duration, fps, loop } = useTransport.getState();
        if (frame >= duration - 1)
          throw new Error("Move the playhead before the end to record.");
        set({ compensation: microphone.start() });
        useTransport.setState({ loop: false });
        transport.dispatch({ type: "shuttle", dir: "forward", fast: false });
        maxLength = duration - frame;
        transition("record", {
          kind: "recording",
          track: armed.track,
          start: frame,
          loop,
        });
        clearMessage();
        let aligned = false;
        stopTransport = useTransport.subscribe((next, previous) => {
          if (next.state.kind !== "playing") {
            const reachedEnd =
              previous.frame >= duration - 2 && next.frame === duration - 1;
            void stop(false, reachedEnd ? duration : previous.frame);
            return;
          }
          if (!aligned && next.frame > frame) {
            const clock = transport.clock();
            if (clock && clock.time > frameTime(frame, fps)) {
              microphone?.alignToPlayback(
                clock.time - frameTime(frame, fps),
                clock.at,
              );
              aligned = true;
            }
          }
        });
        // Bound memory and upload size even on very long timelines: at most 173 MB of mono PCM.
        limit = window.setTimeout(() => void stop(), 1800 * 1000);
      });
    } catch (error) {
      fail(error);
    }
  }

  async function save(track: Track, take: Take) {
    transition("save", { kind: "saving", track });
    clearMessage();
    try {
      if (!take.file) {
        const body = new FormData();
        body.append(
          "file",
          take.blob,
          `voiceover-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.wav`,
        );
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/upload?dir=assets/voiceover`,
          { method: "POST", body, signal: closing.signal },
        );
        if (!response.ok)
          throw new Error(
            `The take could not be saved (${response.status}). Retry or download it.`,
          );
        take.file = UploadSchema.parse(await response.json()).files[0]!;
      }
      if (disposed) return;
      const src = take.file;
      const placed = await editTimeline(
        projectId,
        "Record voiceover",
        (timeline) =>
          voiceoverCommands(timeline, track, take.start, take.duration, src),
      );
      if (!placed)
        throw new Error(
          "The take is saved, but could not be placed. Retry or download it.",
        );
      settle(track);
      useWorkspace.setState((state) => ({
        mediaRevision: state.mediaRevision + 1,
      }));
      clearMessage();
      if (take.droppedMs)
        notify(`${take.droppedMs} ms of microphone audio dropped`);
    } catch (error) {
      if (disposed) return;
      transition("failed", { kind: "save-failed", track, take });
      fail(error);
    }
  }

  async function stop(discard = false, playedThrough?: number) {
    const recording = get().state;
    if (recording.kind !== "recording" || !microphone) return;
    clearRecording();
    transition("stop", { kind: "saving", track: recording.track });
    transport.dispatch({ type: "stop" });
    const { frame, fps } = useTransport.getState();
    const duration = Math.min(
      maxLength,
      Math.max(1, (playedThrough ?? frame) - recording.start),
    );
    useTransport.setState({ loop: recording.loop });
    try {
      const captured = await microphone.finish(frameTime(duration, fps));
      if (disposed) return;
      if (discard && (await confirmDiscard("recording"))) {
        if (disposed) return;
        settle(recording.track);
        clearMessage();
        notify("Voiceover take discarded.");
        return;
      }
      if (disposed) return;
      await save(recording.track, {
        ...captured,
        duration,
        start: recording.start,
        file: null,
      });
    } catch (error) {
      if (!disposed) {
        settle(recording.track);
        fail(error);
      }
    }
  }

  async function recordUnarmed() {
    const view = useTimeline.getState().view;
    if (!view || disposed) return;
    const { timeline } = view;
    const { frame } = useTransport.getState();
    const first =
      timeline.tracks.find(
        (track) => track.kind === "audio" && !track.locked,
      ) ?? newTrack(nextTrackIndex(timeline.tracks), "audio");
    const track = voiceoverTrack(timeline, first, frame, 1);
    await arm(track);
    await start();
    if (get().state.kind !== "recording") return;
    const audio = timeline.tracks.filter((track) => track.kind === "audio");
    const index = audio.findIndex((current) => current.index === track.index);
    notify(
      index < 0
        ? "Recording on a new audio track."
        : `Recording on A${index + 1}.`,
      "info",
    );
  }

  return {
    store,
    arm,
    stop,
    canLeave() {
      const kind = get().state.kind;
      if (!["recording", "saving", "save-failed"].includes(kind)) return true;
      notify(
        kind === "saving"
          ? "Wait for the voiceover take to finish saving."
          : "Save or discard the voiceover take before leaving this project.",
      );
      return false;
    },
    activate() {
      disposed = false;
      closing = new AbortController();
      stopTimeline();
      stopTimeline = useTimeline.subscribe((next, previous) => {
        const state = get().state;
        if (
          next.projectId !== projectId ||
          previous.projectId !== projectId ||
          next.view === previous.view ||
          !next.view ||
          (state.kind !== "arming" && state.kind !== "armed")
        )
          return;
        // An unpersisted A1 placeholder can be armed before any audio track exists.
        const existed = previous.view?.timeline.tracks.some(
          (track) => track.index === state.track.index,
        );
        if (
          !existed ||
          next.view.timeline.tracks.some(
            (track) => track.index === state.track.index,
          )
        )
          return;
        releaseMicrophone();
        transition("trackRemoved", { kind: "idle" });
        clearMessage();
      });
    },
    toggleArm(track: Track) {
      const state = get().state;
      if (state.kind === "armed" && state.track.index === track.index) disarm();
      else void arm(track);
    },
    toggleRecord() {
      if (get().state.kind === "recording") void stop();
      else if (get().state.kind === "idle") void recordUnarmed();
      else if (get().state.kind === "save-failed")
        notify(
          "Save failed. Retry or download the take in the microphone panel before recording again.",
        );
      else if (get().state.kind === "saving")
        notify("Wait for the voiceover take to finish saving.");
      else if (get().state.kind === "arming")
        notify("Wait for the microphone to be ready.");
      else void start();
    },
    answerDiscard,
    retry() {
      const state = get().state;
      if (state.kind === "save-failed") void save(state.track, state.take);
    },
    async discardUnsaved() {
      const state = get().state;
      if (state.kind !== "save-failed" || get().discard) return;
      if (!(await confirmDiscard("unsaved")) || disposed) return;
      settle(state.track);
      clearMessage();
      notify("Voiceover take discarded.");
    },
    download() {
      const state = get().state;
      if (state.kind !== "save-failed") return;
      const url = URL.createObjectURL(state.take.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "voiceover.wav";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    subscribeLevel(listener: (peak: number) => void) {
      meters.add(listener);
      listener(peak);
      return () => {
        meters.delete(listener);
      };
    },
    refreshDevices,
    dispose() {
      disposed = true;
      stopTimeline();
      answerDiscard(false);
      dismissToast();
      closing.abort();
      const state = get().state;
      if (state.kind === "recording") {
        clearRecording();
        transport.dispatch({ type: "stop" });
        useTransport.setState({ loop: state.loop });
      }
      releaseMicrophone();
      transition("dispose", { kind: "idle" });
    },
  };
}

export type VoiceoverSession = ReturnType<typeof createVoiceoverSession>;
