import { clipEnd } from "./timeline/apply";
import type { CommandInput, Timeline, Track } from "./timeline/schema";
import { nextTrackIndex } from "./timeline/tracks";

/** Keep earlier takes intact. Occupied or newly locked destinations get a new audio track. */
export function voiceoverCommands(
  timeline: Timeline,
  armed: Track,
  at: number,
  duration: number,
  src: string,
): CommandInput[] {
  const current = timeline.tracks.find((track) => track.index === armed.index);
  const occupied = timeline.clips.some(
    (clip) =>
      clip.track === armed.index &&
      clip.start < at + duration &&
      clipEnd(clip) > at,
  );
  const separate =
    occupied || current?.locked || (current && current.kind !== "audio");
  const track = separate ? nextTrackIndex(timeline.tracks) : armed.index;
  return [
    ...(!current || separate
      ? [
          {
            type: "setTrack" as const,
            index: track,
            kind: "audio" as const,
            name: "Voiceover",
          },
        ]
      : []),
    {
      type: "insert",
      mode: "place",
      track,
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
