// Runs on the audio thread. Holds the segments near the playhead and their PCM chunks, and
// renders whatever motion the engine last sent. Idle, it returns at once.
import { Player } from "./render";
import type { Motion } from "./render";
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

class ScrubAudio extends AudioWorkletProcessor {
  sources = new Map<string, Map<number, Int16Array>>();
  player = new Player();
  listening = false;
  probe: Probe = { frames: 0, runs: 0, peak: 0, source: null };

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
        case "stop":
          this.player.stop();
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
