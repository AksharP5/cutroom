import { parseRateLane } from "@hyperframes/core/speed-ramp";
import { isAudioKind } from "../../shared/timeline/schema";
import type {
  Clip,
  CommandInput,
  Timeline,
} from "../../shared/timeline/schema";
import { takesGrade } from "../../shared/timeline/grade";
import { TimelineError } from "../../shared/timeline/errors";

/** A clipboard snapshot supplies the main clip plus any linked picture and sound. */
export function pasteAttributes(
  timeline: Timeline,
  copied: readonly Clip[],
  sourceId: string,
  selected: ReadonlySet<string>,
) {
  const source = copied.find(({ id }) => id === sourceId);
  if (!source)
    throw new TimelineError(
      "not_found",
      "Copy a clip before pasting its attributes.",
    );
  if (!selected.size)
    throw new TimelineError(
      "not_found",
      "Select clips to paste the attributes onto.",
    );
  const group = source.link
    ? copied.filter(({ link }) => link === source.link)
    : [source];
  const picture = !isAudioKind(source.kind)
    ? source
    : group.find((clip) => !isAudioKind(clip.kind));
  const sound = source.hasAudio ? source : group.find((clip) => clip.hasAudio);
  const timing = new Set<string>();
  const commands: CommandInput[] = [];
  let skippedSpeed = 0;
  for (const clip of timeline.clips) {
    if (!selected.has(clip.id)) continue;
    const video = picture && !isAudioKind(clip.kind) ? picture : undefined;
    const audio = sound && clip.hasAudio ? sound : undefined;
    const grade = video && takesGrade(video) && takesGrade(clip);
    const region =
      video &&
      (!video.region || video.region.effect === "zoom" || clip.adjustment);
    const transform =
      video &&
      !clip.adjustment &&
      !video.adjustment &&
      !clip.sourceRestrictions?.transform &&
      !video.sourceRestrictions?.transform;
    const effects =
      audio && !audio.sourceRestrictions?.fx && !clip.sourceRestrictions?.fx;
    const clipId = clip.id;
    // setClip merges grade and existing effect parameters, so clear the parts copied in full.
    if (grade || effects)
      commands.push({
        type: "setClip",
        clipId,
        ...(grade && { grade: null }),
        ...(effects && { fx: [] }),
      });
    if (transform || region || (grade && video.grade) || audio)
      commands.push({
        type: "setClip",
        clipId,
        ...(transform && {
          x: video.x,
          y: video.y,
          scaleX: video.scaleX,
          scaleY: video.scaleY,
          rotation: video.rotation,
          crop: video.crop,
          opacity: video.opacity,
          keyframes: video.keyframes,
        }),
        ...(region && { region: video.region }),
        ...(grade && video.grade && { grade: video.grade }),
        ...(audio && { volume: audio.volume }),
        ...(effects && {
          fx: audio.fx.map(({ id, type, enabled, label, params }) => ({
            id,
            type,
            enabled,
            label,
            params,
          })),
        }),
      });
    const speedSource = video && video.mediaStart !== null ? video : audio;
    const key = clip.link ? `link:${clip.link}` : `clip:${clip.id}`;
    if (speedSource && clip.mediaStart !== null && !timing.has(key)) {
      timing.add(key);
      const linked = clip.link
        ? timeline.clips.filter((item) => item.link === clip.link)
        : [clip];
      if (
        group.some(({ automation }) => parseRateLane(automation)) ||
        linked.some(({ automation }) => parseRateLane(automation))
      ) {
        skippedSpeed++;
        continue;
      }
      const speed = speedSource.playbackRate;
      if (linked.some(({ playbackRate }) => playbackRate !== speed))
        commands.push({ type: "setTiming", clipId, playbackRate: speed });
    }
  }
  if (!commands.length && !skippedSpeed)
    throw new TimelineError(
      "unsupported",
      "The selected clips have no compatible attributes to paste.",
    );
  return { commands, skippedSpeed };
}
