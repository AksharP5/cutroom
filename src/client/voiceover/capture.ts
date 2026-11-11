import { z } from "zod";
import { voiceoverWav } from "../../shared/voiceover";
import type { PcmBlock } from "../../shared/voiceover";
import workletUrl from "./pcm-worklet.js?url";

const BlockSchema = z.object({
  frame: z.number().int().nonnegative(),
  samples: z.instanceof(Int16Array),
  peak: z.number().nonnegative(),
});
const SettingsSchema = z.object({
  latency: z.number().nonnegative().optional(),
  deviceId: z.string().optional(),
});

export async function openMicrophone(
  deviceId: string,
  onLevel: (peak: number) => void,
  onEnded: () => void,
) {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error(
      "Microphone recording needs HTTPS or localhost and a browser with microphone support.",
    );
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId && { deviceId: { exact: deviceId } }),
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const context = new AudioContext({
    sampleRate: 48000,
    latencyHint: "interactive",
  });
  try {
    await context.resume();
    await context.audioWorklet.addModule(workletUrl);
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "cutroom-voiceover", {
      channelCount: 1,
      channelCountMode: "explicit",
    });
    source.connect(node).connect(context.destination);
    const track = stream.getAudioTracks()[0]!;
    track.addEventListener("ended", onEnded);
    const settings = SettingsSchema.parse(track.getSettings());
    // Input latency is reported by the device. Playback has its own output pipeline.
    const inputLatency = settings.latency ?? null;
    let blocks: PcmBlock[] = [];
    let recording = false;
    let end: {
      frame: number;
      resolve(): void;
      timer: number;
    } | null = null;
    let start = 0;
    let ready = () => {};
    const firstBlock = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () =>
          reject(new Error("The microphone did not start its audio clock.")),
        3000,
      );
      ready = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    node.port.onmessage = ({ data }: MessageEvent<unknown>) => {
      const block = BlockSchema.parse(data);
      onLevel(block.peak);
      blocks.push(block);
      if (context.getOutputTimestamp().performanceTime) ready();
      if (!recording && blocks.length > 8) blocks.shift();
      if (end && block.frame + block.samples.length >= end.frame) {
        clearTimeout(end.timer);
        end.resolve();
        end = null;
      }
    };
    // The graph clock can advance before the microphone supplies its first quantum.
    // Arm only once samples and the device clock exist, so an immediate Record has both.
    await firstBlock;
    let compensation =
      (inputLatency ?? 0) + context.baseLatency + (context.outputLatency ?? 0);
    const sampleTimeAt = (at: number) => {
      const { contextTime, performanceTime } = context.getOutputTimestamp();
      if (contextTime === undefined || !performanceTime)
        throw new Error(
          "The microphone clock is not ready. Arm the track again.",
        );
      return (
        contextTime + (at - performance.timeOrigin - performanceTime) / 1000
      );
    };
    return {
      deviceId: settings.deviceId ?? deviceId,
      inputLatency,
      compensation,
      start() {
        if (context.state !== "running")
          throw new Error("The microphone is suspended. Arm the track again.");
        compensation =
          (inputLatency ?? 0) +
          context.baseLatency +
          (context.outputLatency ?? 0);
        start = Math.round(
          (sampleTimeAt(performance.timeOrigin + performance.now()) +
            compensation) *
            context.sampleRate,
        );
        recording = true;
        return compensation;
      },
      alignToPlayback(secondsFromStart: number, at: number) {
        // currentTime advances in device-sized batches. The output timestamp pairs the
        // sample clock with performance time, including time spent delivering the preview message.
        start = Math.round(
          (sampleTimeAt(at) + compensation - secondsFromStart) *
            context.sampleRate,
        );
      },
      async finish(seconds: number) {
        const length = Math.ceil(seconds * context.sampleRate);
        const last = start + length;
        try {
          if (
            (blocks.at(-1)?.frame ?? 0) + (blocks.at(-1)?.samples.length ?? 0) <
            last
          )
            await new Promise<void>((resolve) => {
              end = {
                frame: last,
                resolve,
                timer: window.setTimeout(() => {
                  end = null;
                  resolve();
                }, 3000),
              };
            });
          const { bytes, droppedSamples } = voiceoverWav(
            blocks,
            start,
            length,
            context.sampleRate,
          );
          return {
            blob: new Blob([bytes], { type: "audio/wav" }),
            droppedMs: droppedSamples
              ? Math.max(
                  1,
                  Math.round((droppedSamples * 1000) / context.sampleRate),
                )
              : 0,
          };
        } finally {
          recording = false;
          blocks = blocks.slice(-8);
        }
      },
      discard() {
        recording = false;
        blocks = blocks.slice(-8);
      },
      close() {
        if (end) {
          clearTimeout(end.timer);
          end.resolve();
          end = null;
        }
        track.removeEventListener("ended", onEnded);
        stream.getTracks().forEach((track) => track.stop());
        node.disconnect();
        source.disconnect();
        void context.close();
        onLevel(0);
      },
    };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    throw error;
  }
}

export function microphoneError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError")
      return "Microphone permission denied. Allow microphone access for Cutroom, then arm the track again.";
    if (error.name === "NotFoundError")
      return "No microphone found. Connect an input device, then arm the track again.";
    if (error.name === "OverconstrainedError")
      return "The saved microphone is unavailable. Choose another input device.";
    if (error.name === "NotReadableError")
      return "The microphone is busy or unavailable. Close other recording apps and try again.";
  }
  return error instanceof Error ? error.message : String(error);
}
