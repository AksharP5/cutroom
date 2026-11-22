// Runs on the audio thread. Holds the segments near the playhead and their PCM chunks, and
// renders whatever motion the engine last sent. Idle, it returns at once.
import { renderBlock } from "./render";
import type { Motion, Reading, Voice } from "./render";
import { sourceId } from "./segment";
import type { Segment } from "./segment";

declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  },
): void;

export type ToWorklet =
  | { type: "segments"; segments: Segment[] }
  | { type: "chunk"; source: string; index: number; samples: Int16Array }
  | { type: "drop"; source: string; index: number }
  | ({ type: "run" } & Motion)
  | { type: "stop" }
  | { type: "probe" };

/**
 * Rendered frames and motions received since the worklet started, the peak since the last probe,
 * and the last source sample read.
 */
export type Probe = {
  frames: number;
  runs: number;
  peak: number;
  source: number | null;
};

export type FromWorklet =
  | ({ type: "probe" } & Probe)
  /** The first audible block after a `run`, by the audio frame it starts at. */
  | { type: "sounded"; frame: number };

/** Fades in and out over 5 ms, so starting and stopping never click. */
const FADE_STEP = 1 / 240;

class ScrubAudio extends AudioWorkletProcessor {
  sources = new Map<string, Map<number, Int16Array>>();
  voices: Voice[] = [];
  motion: Motion | null = null;
  level = 0;
  target = 0;
  listening = false;
  reading: Reading = { peak: 0, source: null };
  probe: Probe = { frames: 0, runs: 0, peak: 0, source: null };

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<ToWorklet>) => {
      switch (data.type) {
        case "segments":
          this.voices = data.segments.map((segment) => ({
            segment,
            chunks: this.chunksOf(sourceId(segment.source)),
          }));
          return;
        case "chunk":
          this.chunksOf(data.source).set(data.index, data.samples);
          return;
        case "drop":
          this.sources.get(data.source)?.delete(data.index);
          return;
        case "run":
          this.motion = {
            frame: data.frame,
            position: data.position,
            velocity: data.velocity,
          };
          this.target = 1;
          this.listening = true;
          this.probe.runs++;
          return;
        case "stop":
          this.target = 0;
          return;
        case "probe":
          this.port.postMessage({ type: "probe", ...this.probe });
          this.probe.peak = 0;
      }
    };
  }

  chunksOf(source: string) {
    let chunks = this.sources.get(source);
    if (!chunks) this.sources.set(source, (chunks = new Map()));
    return chunks;
  }

  process(_: Float32Array[][], outputs: Float32Array[][]) {
    if (!this.motion) return true;
    const out = outputs[0]![0]!;
    renderBlock(out, currentFrame, this.motion, this.voices, this.reading);
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      if (this.level !== this.target)
        this.level =
          this.target > this.level
            ? Math.min(this.target, this.level + FADE_STEP)
            : Math.max(this.target, this.level - FADE_STEP);
      out[i]! *= this.level;
      peak = Math.max(peak, Math.abs(out[i]!));
    }
    if (!this.level && !this.target) this.motion = null;
    this.probe.frames += out.length;
    this.probe.peak = Math.max(this.probe.peak, peak);
    this.probe.source = this.reading.source;
    if (this.listening && peak > 0) {
      this.listening = false;
      this.port.postMessage({ type: "sounded", frame: currentFrame });
    }
    return true;
  }
}

registerProcessor("cutroom-scrub-audio", ScrubAudio);
