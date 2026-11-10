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

/** Sound can be muted independently of picture, including embedded audio in authored video. */
export function trackMix(tracks: readonly Track[]) {
  const solo = tracks.some((track) => track.kind === "audio" && track.solo);
  const hidden = new Set<number>();
  const muted = new Set<number>();
  for (const track of tracks) {
    const silent = !track.enabled || track.muted || (solo && !track.solo);
    if (silent) muted.add(track.index);
    if (!track.enabled || (track.kind === "audio" && silent))
      hidden.add(track.index);
  }
  return { hidden, muted };
}

export type TrackMix = ReturnType<typeof trackMix>;

export const clipVisible = (clip: Clip, suppressed: ReadonlySet<number>) =>
  clip.enabled && !suppressed.has(clip.track);
