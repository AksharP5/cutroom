import {
  AUDIO_SAMPLE_RATE,
  attrMicros,
  frames,
  micros,
  resolvePiece,
  sampleOf,
  secondsOf,
  sourceSampleOffset,
  subtract,
} from "../../shared/timeline/piece.ts";
import { mixFromHead } from "../../shared/timeline/mix.ts";
import type { AudioElement } from "@hyperframes/engine";
import { placedMedia } from "../../shared/timeline/placedMedia.ts";
import { documentRampRuns, runId } from "../../shared/timeline/rampRuns.ts";
import type { RunSlice } from "../../shared/timeline/rampRuns.ts";
import type { Fps } from "../../shared/timeline/schema.ts";

export { AUDIO_SAMPLE_RATE };
export const audioFrameSample = (frame: number, fps: Fps) =>
  Number(sampleOf(frames(frame, fps)));

export type AudioMixElement = AudioElement & {
  samples?: { start: number; end: number };
  /** A ramp piece's samples of its run, and the run file when the server prepared it. */
  rampRun?: RunSlice & { file?: string };
};

const audioKey = (audio: AudioElement) =>
  audio.type === "video"
    ? `video:${audio.id.replace(/-audio$/, "")}`
    : `audio:${audio.id}`;

/** Put existing producer audio tracks on their authored sample clocks. */
export function sampleGridAudio(
  audios: AudioElement[],
  html: string,
  subCompositions: ReadonlyMap<string, string> = new Map(),
  beforeProbe?: AudioElement[],
  runFiles: Readonly<Record<string, string>> = {},
): AudioMixElement[] {
  if (!audios.length) return audios;
  const placement = placedMedia(html, subCompositions);
  const { fps, placed, knownWindows } = placement;
  const runs: ReturnType<typeof documentRampRuns> = audios.some(
    ({ playbackRate }) => typeof playbackRate === "object",
  )
    ? documentRampRuns(placement)
    : new Map();
  const staticAudio =
    beforeProbe &&
    new Map(beforeProbe.map((audio) => [audioKey(audio), audio]));
  return audios.flatMap((audio) => {
    const key = audioKey(audio);
    const original = staticAudio?.get(key);
    // Script-created tracks and unknown lengths still use the producer's measurements.
    if (staticAudio && !original) return [audio];
    const item = placed.get(key);
    if (item?.kind !== "media") return knownWindows.has(key) ? [] : [audio];
    const piece = resolvePiece({ ...item, loop: audio.loop }, fps);
    const start = Number(piece.samples.start);
    const measuredEnd = original && Math.abs(audio.end - original.end) > 1e-6;
    const end = measuredEnd
      ? Number(sampleOf(micros(attrMicros(audio.end))))
      : Number(piece.samples.end);
    if (end <= start) return [];
    const authored =
      !original || Math.abs(audio.mediaStart - original.mediaStart) <= 1e-6;
    const offset = sourceSampleOffset(piece);
    const slice =
      authored && !audio.loop && !measuredEnd ? runs.get(key) : undefined;
    const mediaStart =
      offset !== null && audio.playbackRate === 1 && authored
        ? Number(piece.samples.start + offset) / AUDIO_SAMPLE_RATE
        : audio.mediaStart;
    // The producer starts the track where a trimmed mount opens; its fades and lanes stay clip-local.
    const mix = mixFromHead(
      {
        fadeIn: audio.fadeIn ?? 0,
        fadeOut: audio.fadeOut ?? 0,
        automation: audio.automation ?? null,
        volume: audio.volume ?? null,
      },
      secondsOf(subtract(piece.played.start, piece.edge.start)),
      secondsOf(subtract(piece.local.end, piece.local.start)),
    );
    return [
      {
        ...audio,
        start: secondsOf(piece.played.start),
        end: measuredEnd ? audio.end : secondsOf(piece.played.end),
        mediaStart,
        ...(mix && {
          fadeIn: mix.fadeIn,
          fadeOut: mix.fadeOut,
          automation: mix.automation ?? undefined,
        }),
        samples: { start, end },
        ...(slice && {
          rampRun: {
            run: slice.run,
            from: slice.from,
            to: slice.to,
            file: runFiles[runId(slice.src, slice.run)],
          },
        }),
      },
    ];
  });
}
