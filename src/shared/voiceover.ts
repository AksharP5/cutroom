import { clipEnd } from "./timeline/apply";
import type { CommandInput, Timeline, Track } from "./timeline/schema";
import { newTrack, nextTrackIndex } from "./timeline/tracks";

/** Prefer the armed lane, then the first unlocked audio lane with room for the whole take. */
export function voiceoverTrack(
  timeline: Timeline,
  armed: Track,
  at: number,
  duration: number,
): Track {
  const available = (track: Track) =>
    track.kind === "audio" &&
    !track.locked &&
    !timeline.clips.some(
      (clip) =>
        clip.track === track.index &&
        clip.start < at + duration &&
        clipEnd(clip) > at,
    );
  const current =
    timeline.tracks.find((track) => track.index === armed.index) ?? armed;
  if (available(current)) return current;
  return (
    timeline.tracks.find(available) ?? {
      ...newTrack(nextTrackIndex(timeline.tracks), "audio"),
      name: "Voiceover",
    }
  );
}

export function voiceoverCommands(
  timeline: Timeline,
  armed: Track,
  at: number,
  duration: number,
  src: string,
): CommandInput[] {
  const track = voiceoverTrack(timeline, armed, at, duration);
  return [
    ...(!timeline.tracks.some((current) => current.index === track.index)
      ? [
          {
            type: "setTrack" as const,
            index: track.index,
            kind: "audio" as const,
            name: "Voiceover",
          },
        ]
      : []),
    {
      type: "insert",
      mode: "place",
      track: track.index,
      at,
      clip: { kind: "voiceover", src, duration, label: "Voiceover" },
    },
  ];
}

export interface PcmBlock {
  frame: number;
  samples: Int16Array;
}

/** Sample-clock cropping also removes capture latency without rounding it to a video frame. */
export function voiceoverWav(
  blocks: readonly PcmBlock[],
  start: number,
  length: number,
  sampleRate: number,
) {
  const bytes = new ArrayBuffer(44 + length * 2);
  const view = new DataView(bytes);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 2, true);
  let written = 0;
  for (const block of blocks) {
    const from = Math.max(start, block.frame);
    const end = Math.min(start + length, block.frame + block.samples.length);
    if (end <= from) continue;
    for (let frame = from; frame < end; frame++)
      view.setInt16(
        44 + (frame - start) * 2,
        block.samples[frame - block.frame]!,
        true,
      );
    written += end - from;
  }
  return { bytes, droppedSamples: length - written };
}
