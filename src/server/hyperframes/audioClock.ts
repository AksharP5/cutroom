import type { AudioElement } from "@hyperframes/engine";
import {
  audioSampleAt,
  resolveRampPlayback,
} from "../../shared/timeline/rampWindow.ts";
import type { RampPlayback } from "../../shared/timeline/rampWindow.ts";

export {
  AUDIO_SAMPLE_RATE,
  audioSampleAt,
} from "../../shared/timeline/rampWindow.ts";

export type TimedAudio = AudioElement & {
  rampTiming?: RampPlayback;
  samples?: { start: number; end: number };
};

export function audioSamples({ samples, rampTiming, start, end }: TimedAudio) {
  return (
    samples ??
    rampTiming?.pcm ?? { start: audioSampleAt(start), end: audioSampleAt(end) }
  );
}

export function resolveAudioTiming(audio: TimedAudio): TimedAudio {
  const rate = audio.playbackRate;
  if (
    audio.rampTiming ||
    typeof rate !== "object" ||
    audio.loop ||
    audio.end <= audio.start
  )
    return audio;
  return { ...audio, rampTiming: resolveRampPlayback(audio, rate) };
}
