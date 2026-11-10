import type { Clip, Track } from "./schema";

export const newTrack = (index: number, kind: Track["kind"]): Track => ({
  index,
  kind,
  name: null,
  locked: false,
  autoSelect: true,
  enabled: true,
  muted: false,
  solo: false,
});

/** Indexes are stable identities, shared with HTML's data-track-index. */
export const nextTrackIndex = (tracks: readonly Track[]) =>
  Math.max(-1, ...tracks.map((track) => track.index)) + 1;

/** Track controls never change the clip's own enabled flag. */
export function suppressedTracks(tracks: readonly Track[]) {
  const solo = tracks.some((track) => track.kind === "audio" && track.solo);
  return new Set(
    tracks
      .filter(
        (track) =>
          !track.enabled ||
          (track.kind === "audio" && (track.muted || (solo && !track.solo))),
      )
      .map((track) => track.index),
  );
}

export const clipVisible = (clip: Clip, suppressed: ReadonlySet<number>) =>
  clip.enabled && !suppressed.has(clip.track);
