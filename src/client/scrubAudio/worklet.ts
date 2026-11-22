// Runs on the audio thread. Holds the segments near the playhead and their PCM chunks, and
// renders whatever motion the engine last sent. Idle, it returns at once.
import { Player } from "./render";
import type { Chase, Motion } from "./render";
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
  | ({ type: "chase" } & Chase)
  /** One frame's samples: output samples `[position, position + length)`. */
  | { type: "frame"; position: number; length: number }
  | { type: "stop" }
  | { type: "probe" };

/**
 * Rendered frames and shuttle motions received since the worklet started; since the last probe,
 * the peak and the lowest and highest source sample read (null when none); and the last read.
 */
export type Probe = {
  frames: number;
  runs: number;
  peak: number;
  source: number | null;
  low: number | null;
  high: number | null;
};

export type FromWorklet =
  | ({ type: "probe" } & Probe)
  /** The first audible block after a `run`, by the audio frame it starts at. */
  | { type: "sounded"; frame: number };

class ScrubAudio extends AudioWorkletProcessor {
  sources = new Map<string, Map<number, Int16Array>>();
  player = new Player();
  listening = false;
  probe: Probe = {
    frames: 0,
    runs: 0,
    peak: 0,
    source: null,
    low: null,
    high: null,
  };

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<ToWorklet>) => {
      switch (data.type) {
        case "segments":
          this.player.setVoices(
            data.segments.map((segment) => ({
              segment,
              chunks: this.chunksOf(sourceId(segment.source)),
            })),
          );
          return;
        case "chunk":
          this.chunksOf(data.source).set(data.index, data.samples);
          return;
        case "drop":
          this.sources.get(data.source)?.delete(data.index);
          return;
        case "run":
          this.player.run({
            frame: data.frame,
            position: data.position,
            velocity: data.velocity,
          });
          this.listening = true;
          this.probe.runs++;
          return;
        case "chase":
          // The first sound of a drag, for the latency probe.
          if (!this.player.sounding) this.listening = true;
          this.player.chase(
            {
              frame: data.frame,
              position: data.position,
              velocity: data.velocity,
              rest: data.rest,
            },
            currentFrame,
          );
          return;
        case "frame":
          this.player.blip(data.position, data.length, currentFrame);
          this.listening = true;
          return;
        case "stop":
          this.player.stop();
          return;
        case "probe":
          const { low, high } = this.player.reading;
          this.port.postMessage({
            type: "probe",
            ...this.probe,
            low: Number.isFinite(low) ? low : null,
            high: Number.isFinite(high) ? high : null,
          });
          this.probe.peak = 0;
          this.player.reading.low = Infinity;
          this.player.reading.high = -Infinity;
      }
    };
  }

  chunksOf(source: string) {
    let chunks = this.sources.get(source);
    if (!chunks) this.sources.set(source, (chunks = new Map()));
    return chunks;
  }

  process(_: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]![0]!;
    if (!this.player.process(out, currentFrame)) return true;
    const { peak, source } = this.player.reading;
    this.probe.frames += out.length;
    this.probe.peak = Math.max(this.probe.peak, peak);
    this.probe.source = source;
    if (this.listening && peak > 0) {
      this.listening = false;
      this.port.postMessage({ type: "sounded", frame: currentFrame });
    }
    return true;
  }
}

registerProcessor("cutroom-scrub-audio", ScrubAudio);
