import { mediaKind } from "../media";
import {
  framesAfterOut,
  framesBeforeIn,
  resolveClip,
  sourceAtEdge,
} from "./clipTiming";
import { frames, secondsOf, sourceAt } from "./piece";
import type { ExactTime } from "./piece";
import { isAudioKind, MAX_VERSIONS } from "./schema";
import type { Clip, Fps, Timeline, Version } from "./schema";
import { framesAfter, framesBefore } from "./transition";

/** A scene version is an HTML composition file; the query or hash does not count. */
export const isCompositionFile = (src: string) =>
  /\.html?$/i.test(src.split(/[?#]/, 1)[0]!);

export const mediaVersions = (kind: Clip["kind"]) =>
  kind === "video" || isAudioKind(kind);

/** Whether `src` can be a version of a clip of this kind. */
export const fitsVersion = (kind: Clip["kind"], src: string) =>
  kind === "composition"
    ? isCompositionFile(src)
    : kind !== "element" &&
      mediaKind(src.split(/[?#]/, 1)[0]!)?.kind ===
        (isAudioKind(kind) ? "audio" : kind);

/** The place of the version a clip shows in its list, or -1 when it has none. */
export const activeVersion = (
  clip: Pick<Clip, "src" | "versions" | "versionIndex">,
) =>
  clip.versionIndex ??
  clip.versions?.findIndex(({ src }) => src === clip.src) ??
  -1;

export const sourceRate = (version: Version, fps: Fps) =>
  version.sourceFps ?? fps.num / fps.den;

export const versionStart = (version: Version, fps: Fps) =>
  (version.sourceIn ?? 0) / sourceRate(version, fps);

export const versionOffset = (version: Version, seconds: number, fps: Fps) =>
  Math.round(seconds * sourceRate(version, fps) * 1e9) / 1e9 + 0;

/** The clip as it would play a take: same edit and source map, the take's in-point and length. */
const asTake = (clip: Clip, mediaStart: number, version: Version): Clip => ({
  ...clip,
  mediaStart,
  sourceDuration: version.sourceDuration ?? null,
});

/** Source seconds a take shows at a timeline frame, through the shared piece resolver. */
export function versionSourceAt(
  clip: Clip,
  version: Version,
  frame: number,
  fps: Fps,
) {
  const time = sourceAt(
    resolveClip(asTake(clip, versionStart(version, fps), version), fps),
    frames(frame, fps),
  );
  return typeof time === "number" ? time : secondsOf(time);
}

/**
 * Move every take's in-point with the clip's edge, along the clip's own source map. The shown
 * take takes the clip's new in-point as it is, so the two never disagree.
 */
export function versionsAtEdge(
  clip: Clip,
  shown: number | null,
  authored: ExactTime,
  edge: ExactTime,
  fps: Fps,
  edgeFps = fps,
) {
  if (!clip.versions || !mediaVersions(clip.kind)) return clip.versions;
  const active = activeVersion(clip);
  return clip.versions.map((version, i) => {
    const mediaStart =
      i === active
        ? shown
        : sourceAtEdge(
            { ...clip, mediaStart: versionStart(version, fps) },
            authored,
            edge,
            fps,
            edgeFps,
          ).mediaStart;
    return mediaStart === null
      ? version
      : { ...version, sourceIn: versionOffset(version, mediaStart, edgeFps) };
  });
}

/** Only a video's own separated sound follows its take. Other linked edits keep their sources. */
export function versionPartners(clips: readonly Clip[], picture: Clip) {
  if (picture.kind !== "video" || !picture.link) return [];
  return clips.filter(
    (clip) =>
      isAudioKind(clip.kind) &&
      clip.link === picture.link &&
      clip.src === picture.src,
  );
}

export function versionOwner(clips: readonly Clip[], clip: Clip): Clip {
  if (!isAudioKind(clip.kind) || !clip.link) return clip;
  return (
    clips.find(
      (picture) =>
        picture.kind === "video" &&
        picture.link === clip.link &&
        picture.src === clip.src,
    ) ?? clip
  );
}

/** Whether the clip can take another version, including a picture's audio track lock. */
export function canAddVersion(clip: Clip, { clips, tracks }: Timeline) {
  if (
    !clip.src ||
    !mediaVersions(clip.kind) ||
    versionOwner(clips, clip) !== clip
  )
    return false;
  if ((clip.versions?.length ?? 0) >= MAX_VERSIONS) return false;
  const affected = [clip, ...versionPartners(clips, clip)];
  return !tracks.some(
    (track) =>
      track.locked && affected.some((member) => member.track === track.index),
  );
}

/** Frames a take lacks to cover the clip and its transition handles. */
function shortage(clip: Clip, start: number, version: Version, fps: Fps) {
  if (isAudioKind(clip.kind) && version.silent) return 0;
  const take = asTake(clip, start, version);
  const inHandle = clip.transitionIn ? framesBefore(clip.transitionIn) : 0;
  const before = inHandle - framesBeforeIn(take, fps);
  if (before > 0) return before;
  const outHandle = clip.transitionOut ? framesAfter(clip.transitionOut) : 0;
  return Math.max(0, outHandle - framesAfterOut(take, fps));
}

export function versionFit(
  clip: Clip,
  partners: readonly Clip[],
  version: Version,
  fps: Fps,
): Version {
  const { shortBy: _shortBy, ...take } = version;
  const start = versionStart(version, fps);
  const missing = Math.max(
    shortage(clip, start, version, fps),
    ...partners.map((partner) =>
      shortage(
        partner,
        start + (partner.mediaStart ?? 0) - (clip.mediaStart ?? 0),
        version,
        fps,
      ),
    ),
  );
  return { ...take, fits: missing === 0, ...(missing && { shortBy: missing }) };
}

export function updateVersionFits(timeline: Timeline): Timeline {
  const { clips, fps } = timeline;
  const pictures = new Map<string, Clip[]>();
  for (const clip of clips) {
    if (!clip.link) continue;
    const group = pictures.get(clip.link) ?? [];
    group.push(clip);
    pictures.set(clip.link, group);
  }
  return {
    ...timeline,
    clips: clips.map((clip) => {
      if (!clip.versions || !mediaVersions(clip.kind)) return clip;
      const partners = versionPartners(
        pictures.get(clip.link ?? "") ?? [],
        clip,
      );
      const versions = clip.versions.map((version) =>
        versionFit(clip, partners, version, fps),
      );
      return versions.some(
        (version, i) =>
          version.fits !== clip.versions![i]!.fits ||
          version.shortBy !== clip.versions![i]!.shortBy,
      )
        ? { ...clip, versions }
        : clip;
    }),
  };
}

export const versionShortReason = (version: Version, fps: Fps) => {
  const frames = version.shortBy ?? 0;
  const rate = Math.round(fps.num / fps.den);
  return `${version.name} is ${Math.floor(frames / rate)}:${String(frames % rate).padStart(2, "0")} shorter than the clip.`;
};

export function versionMedia(
  version: Version,
  lengths: ReadonlyMap<string, number>,
  silent: ReadonlySet<string>,
  files?: ReadonlySet<string>,
): Version {
  const {
    sourceDuration: _duration,
    silent: _silent,
    offline: _offline,
    ...take
  } = version;
  const duration = lengths.get(take.src);
  return {
    ...take,
    ...(duration === undefined ? {} : { sourceDuration: duration }),
    ...(silent.has(take.src) && { silent: true }),
    ...(files && !files.has(take.src) && { offline: true }),
  };
}

/** The next playable row in menu and keyboard order. */
export function nextAudition(available: readonly number[], current: number) {
  if (available.length < 2) return undefined;
  return available.find((index) => index > current) ?? available[0];
}
