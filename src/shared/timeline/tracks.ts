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

/** Every timeline shows a video and an audio track, so a kind it lacks gets an empty one. */
export function shownTracks(tracks: readonly Track[]) {
  const shown = [...tracks];
  for (const kind of ["video", "audio"] as const) {
    if (shown.some((track) => track.kind === kind)) continue;
    let index = 0;
    while (shown.some((track) => track.index === index)) index++;
    shown.push(newTrack(index, kind));
  }
  return shown;
}

/**
 * Where placing media without a drag puts picture and sound: the chosen track of each kind while
 * the timeline has it, otherwise the first one, which the headers show as V1 and A1.
 */
export function destinationTracks(
  tracks: readonly Track[],
  chosen: Partial<Record<Track["kind"], number>>,
) {
  const shown = shownTracks(tracks);
  const of = (kind: Track["kind"]) =>
    shown.find(
      (track) => track.kind === kind && track.index === chosen[kind],
    ) ?? shown.find((track) => track.kind === kind)!;
  return { video: of("video"), audio: of("audio") };
}

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
