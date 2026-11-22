import { useWorkspace } from "../workspace";
import { useTimeline } from "../edit/timeline";
import { velocity } from "../edit/transport";
import type { Transport } from "../edit/transport";
import { chunksNear, createChunkCache, loadChunk } from "./chunks";
import { scrubPlan } from "./plan";
import { sourceId } from "./segment";
import type { Segment } from "./segment";
import type { TimelineView } from "../../shared/timeline/schema";
import type { FromWorklet, Probe, ToWorklet } from "./worklet";
import workletUrl from "./worklet.ts?worker&url";

const SAMPLE_RATE = 48_000;
/** Segments and chunks within this many samples of the playhead are held, on either side. */
const REACH = 20 * SAMPLE_RATE;
/** How far the playhead moves before the held window follows it. */
const REFRESH = 5 * SAMPLE_RATE;
const SUSPEND_MS = 5000;

/** What end-to-end tests read through `window.cutroomScrubAudio`. */
export type ScrubAudioProbe = {
  /** The AudioContext's state, or null before one exists. */
  context(): AudioContextState | null;
  /** The worklet's own counters, or null before it exists. */
  probe(): Promise<Probe | null>;
  /** When the latest shuttle first sounded: page time the block was posted and heard. */
  sounded: { posted: number; heard: number; outputLatency: number } | null;
};

declare global {
  interface Window {
    cutroomScrubAudio?: ScrubAudioProbe;
  }
}

/**
 * Shuttle sound. Silent until the first shuttle of the session, which creates the AudioContext.
 * In `playing` and `stopped` the preview runtime owns sound and this stays quiet; a shuttle runs
 * the worklet on the audio clock, re-anchored if it strays more than a frame from the playhead.
 */
export function startScrubAudio(transport: Transport) {
  let audio: {
    context: AudioContext;
    node: AudioWorkletNode | null;
    cache: ReturnType<typeof createChunkCache>;
  } | null = null;
  let plan: {
    view: TimelineView;
    files: Readonly<Record<string, string | null>>;
    segments: Segment[];
  } | null = null;
  /** The held window's centre, in output samples. */
  let centre = Number.NaN;
  let anchor: { frame: number; position: number; velocity: number } | null =
    null;
  let suspend = 0;
  let resuming: Promise<void> | null = null;
  let parked = 0;
  const probes: ((probe: Probe) => void)[] = [];
  const hook: ScrubAudioProbe = {
    context: () => audio?.context.state ?? null,
    probe: () =>
      audio?.node
        ? new Promise((resolve) => {
            probes.push(resolve);
            post({ type: "probe" });
          })
        : Promise.resolve(null),
    sounded: null,
  };
  window.cutroomScrubAudio = hook;

  function post(message: ToWorklet, transfer: Transferable[] = []) {
    audio?.node?.port.postMessage(message, transfer);
  }

  /**
   * The audio frame the device plays at page time `at`, or null until the output clock runs.
   * Just after the context starts or resumes, the clock still reports where it stopped.
   */
  function frameAt(context: AudioContext, at: number) {
    const { contextTime, performanceTime } = context.getOutputTimestamp();
    if (
      context.state !== "running" ||
      !contextTime ||
      !performanceTime ||
      at - performanceTime > 100
    )
      return null;
    return Math.round(
      (contextTime + (at - performanceTime) / 1000) * SAMPLE_RATE,
    );
  }

  function create() {
    const context = new AudioContext({
      sampleRate: SAMPLE_RATE,
      latencyHint: "interactive",
    });
    const cache = createChunkCache({
      load: (chunk, signal) => {
        const { projectId } = useTimeline.getState();
        return projectId
          ? loadChunk(projectId, chunk, signal)
          : Promise.resolve({ kind: "pending" });
      },
      send: ({ source, index }, samples) =>
        post({ type: "chunk", source: sourceId(source), index, samples }, [
          samples.buffer,
        ]),
      drop: ({ source, index }) =>
        post({ type: "drop", source: sourceId(source), index }),
    });
    audio = { context, node: null, cache };
    const created = audio;
    void context.audioWorklet
      .addModule(workletUrl)
      .then(() => {
        if (audio !== created) return;
        const node = new AudioWorkletNode(context, "cutroom-scrub-audio", {
          numberOfInputs: 0,
          outputChannelCount: [1],
        });
        node.port.onmessage = ({ data }: MessageEvent<FromWorklet>) => {
          if (data.type === "probe") return probes.shift()?.(data);
          hook.sounded = {
            posted: performance.now(),
            heard: pageTimeOf(context, data.frame),
            outputLatency: context.outputLatency ?? 0,
          };
        };
        node.connect(context.destination);
        created.node = node;
        centre = Number.NaN;
        anchor = null;
        sync();
      })
      .catch((error: unknown) => {
        console.warn("Scrub audio could not start", error);
        sync();
      });
  }

  /** The segments that can sound, rebuilt only when the timeline or the file listing changed. */
  function segments() {
    const { view } = useTimeline.getState();
    const files = useWorkspace.getState().fileChanges;
    if (!view) return [];
    if (plan?.view !== view || plan.files !== files) {
      plan = {
        view,
        files,
        segments: scrubPlan(view.timeline, {
          composition: view.composition,
          versions: files,
        }).filter(({ gain }) => gain.some(({ gain }) => gain > 0)),
      };
      centre = Number.NaN;
    }
    return plan.segments;
  }

  /** Holds the segments and chunks within reach of output sample `at`. */
  function hold(at: number) {
    const all = segments();
    if (Math.abs(at - centre) < REFRESH) return;
    centre = at;
    const near = all.filter(
      ({ samples }) => samples.start < at + REACH && samples.end > at - REACH,
    );
    post({ type: "segments", segments: near });
    audio?.cache.want(chunksNear(near, at - REACH, at + REACH, at));
  }

  /** Stops any sound, and lets the context sleep once nothing has sounded for a while. */
  function quiet() {
    if (anchor) post({ type: "stop" });
    anchor = null;
    if (!audio || suspend || audio.context.state !== "running") return;
    const { context } = audio;
    suspend = window.setTimeout(() => {
      suspend = 0;
      void context.suspend();
    }, SUSPEND_MS);
  }

  function sync() {
    const { state, frame, fps, muted } = transport.use.getState();
    const speed = velocity(state);
    const samplesPerFrame = (SAMPLE_RATE * fps.den) / fps.num;
    const position = frame * samplesPerFrame;
    if (state.kind !== "shuttle" || muted) {
      quiet();
      // A parked playhead fetches what is under it, once the engine has been used.
      if (audio?.node && state.kind === "stopped") {
        clearTimeout(parked);
        parked = window.setTimeout(() => hold(position), 300);
      }
      return;
    }
    if (!audio) return create();
    const { context, node } = audio;
    if (!node) return;
    clearTimeout(suspend);
    suspend = 0;
    hold(position);
    if (context.state !== "running") {
      resuming ??= context.resume().finally(() => {
        resuming = null;
        sync();
      });
      return;
    }
    const now = performance.now();
    const heard = frameAt(context, now);
    // The next frame of the shuttle asks again.
    if (heard === null) return;
    const at = (transport.shuttlePosition(now) ?? frame) * samplesPerFrame;
    if (anchor?.velocity === speed) {
      // The output clock jitters by a few milliseconds, and the picture moves once per display
      // refresh, which at 8x spans several frames: within a frame or a refresh of motion,
      // whichever is longer, the sound is in step with the picture.
      const tolerance = Math.max(
        samplesPerFrame,
        (Math.abs(speed) * SAMPLE_RATE) / 60,
      );
      const sound = anchor.position + (heard - anchor.frame) * speed;
      if (Math.abs(sound - at) <= tolerance) return;
    }
    anchor = { frame: heard, position: at, velocity: speed };
    post({ type: "run", ...anchor });
  }

  const unsubscribe = transport.use.subscribe((now, before) => {
    if (
      now.state === before.state &&
      now.muted === before.muted &&
      now.state.kind !== "shuttle" &&
      !audio?.node
    )
      return;
    sync();
  });

  return () => {
    unsubscribe();
    clearTimeout(suspend);
    clearTimeout(parked);
    if (window.cutroomScrubAudio === hook) delete window.cutroomScrubAudio;
    if (!audio) return;
    audio.cache.close();
    void audio.context.close();
    audio = null;
  };
}

/** The page time an audio frame is heard, through the output clock. */
function pageTimeOf(context: AudioContext, frame: number) {
  const { contextTime = 0, performanceTime = 0 } = context.getOutputTimestamp();
  return performanceTime + (frame / SAMPLE_RATE - contextTime) * 1000;
}
