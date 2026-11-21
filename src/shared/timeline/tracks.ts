import type { Clip, Timeline, Track } from "./schema";
import type { TimelineViewSettings } from "./view";

export const newTrack = (index: number, kind: Track["kind"]): Track => ({
  index,
  kind,
  name: null,
  locked: false,
  autoSelect: true,
  enabled: true,
  muted: false,
  solo: false,
  volume: 1,
  fx: [],
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
  chosen: TimelineViewSettings["destinations"],
) {
  const shown = shownTracks(tracks);
  const of = (kind: Track["kind"]) =>
    shown.find(
      (track) => track.kind === kind && track.index === chosen[kind],
    ) ?? shown.find((track) => track.kind === kind)!;
  return {
    video: of("video"),
    audio: of("audio"),
    videoEnabled: chosen.videoEnabled !== false,
    audioEnabled: chosen.audioEnabled !== false,
  };
}

/**
 * Sound can be muted independently of picture, including embedded audio in authored video. While
 * anything is soloed, a clip sounds when its track or its bus is soloed; mute wins over solo.
 */
export function trackMix(
  timeline: Pick<Timeline, "tracks" | "authoredAudioGroups">,
) {
  const soloGroups = new Set(
    (timeline.authoredAudioGroups ?? []).flatMap(({ id, solo }) =>
      solo ? [id] : [],
    ),
  );
  const solo =
    soloGroups.size > 0 ||
    timeline.tracks.some((track) => track.kind === "audio" && track.solo);
  const hidden = new Set<number>();
  const muted = new Set<number>();
  /** Tracks only another solo silences, where a clip in a soloed bus still sounds. */
  const soloedOut = new Set<number>();
  for (const track of timeline.tracks) {
    const off = !track.enabled || track.muted;
    const silent = off || (solo && !track.solo);
    if (silent) muted.add(track.index);
    if (!off && silent) soloedOut.add(track.index);
    if (!track.enabled || (track.kind === "audio" && silent))
      hidden.add(track.index);
  }
  return { hidden, muted, solo, soloedOut, soloGroups };
}

export type TrackMix = ReturnType<typeof trackMix>;

const soloedBus = (
  mix: TrackMix,
  clip: Pick<Clip, "track" | "authoredAudioGroupId">,
) =>
  clip.authoredAudioGroupId !== undefined &&
  mix.soloGroups.has(clip.authoredAudioGroupId) &&
  mix.soloedOut.has(clip.track);

/** Whether the mix hides this clip: a disabled track, or an audio track that is silent for it. */
export const mixHides = (
  mix: TrackMix,
  clip: Pick<Clip, "track" | "authoredAudioGroupId">,
) => mix.hidden.has(clip.track) && !soloedBus(mix, clip);

/** Whether the mix silences this clip's sound, picture aside. */
export const mixSilences = (
  mix: TrackMix,
  clip: Pick<Clip, "track" | "authoredAudioGroupId">,
) => mix.muted.has(clip.track) && !soloedBus(mix, clip);

export const clipVisible = (clip: Clip, mix: TrackMix) =>
  clip.enabled && !mixHides(mix, clip);
