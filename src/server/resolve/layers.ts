import { AsyncLocalStorage } from "node:async_hooks";
import { isAudioKind } from "../../shared/timeline/schema";
import type { Clip, Timeline } from "../../shared/timeline/schema";
import { trackMix } from "../../shared/timeline/tracks";
import type { ParsedComposition } from "../timeline/composition";
import { applyTrackMix } from "../timeline/composition";

/**
 * The composition HTML a layer render draws, by absolute source path. The Resolve export sets it
 * around the render request it makes; nothing a client sends reaches it.
 */
export const layerSources = new AsyncLocalStorage<Record<string, string>>();

/** One video track's clips that Resolve can't open, rendered together with transparency. */
export interface LayerTrack {
  track: number;
  /** Composition frames the render covers, end exclusive. */
  start: number;
  end: number;
  clips: Clip[];
  /** The exported layer includes the picture from lower tracks where its effect needs it. */
  flatten: boolean;
}

const isZoomLayer = (clip: Clip) =>
  clip.adjustment && clip.region?.effect === "zoom";

/**
 * Render each track's ordinary graphics together. An adjustment replaces lower
 * tracks only for its own cut, so render it separately from transparent graphics.
 */
export function layerTracks(
  timeline: Timeline,
  native: ReadonlySet<string>,
): LayerTrack[] {
  const { hidden } = trackMix(timeline);
  const byTrack = new Map<number, Clip[]>();
  const layers: LayerTrack[] = [];
  for (const clip of timeline.clips) {
    if (
      isAudioKind(clip.kind) ||
      native.has(clip.id) ||
      (clip.adjustment && !clip.grade && (!clip.region || isZoomLayer(clip))) ||
      !clip.enabled ||
      hidden.has(clip.track)
    )
      continue;
    if (clip.adjustment) {
      layers.push({
        track: clip.track,
        start: clip.start,
        end: clip.start + clip.duration,
        clips: [clip],
        flatten: true,
      });
      continue;
    }
    const clips = byTrack.get(clip.track);
    if (clips) clips.push(clip);
    else byTrack.set(clip.track, [clip]);
  }
  for (const [track, clips] of byTrack) {
    layers.push({
      track,
      start: Math.min(...clips.map((clip) => clip.start)),
      end: Math.max(...clips.map((clip) => clip.start + clip.duration)),
      clips: clips.toSorted((a, b) => a.start - b.start),
      flatten: false,
    });
  }
  return layers.sort((a, b) => a.track - b.track || a.start - b.start);
}

/**
 * The composition with only one layer showing: that track's clips (and, under a blur or
 * highlight, every track below it) plus the zoom layers that move them, all without sound.
 */
export function layerHtml(parsed: ParsedComposition, layer: LayerTrack) {
  const { timeline } = parsed;
  const shown = new Set(layer.clips.map((clip) => clip.id));
  const order = timeline.tracks
    .filter((track) => track.kind === "video")
    .map((track) => track.index)
    .sort((a, b) => a - b);
  const below = (track: number) =>
    layer.flatten && order.indexOf(track) < order.indexOf(layer.track);
  const shows = (clip: Clip) =>
    !isAudioKind(clip.kind) &&
    (shown.has(clip.id) || isZoomLayer(clip) || below(clip.track));
  // An exported grade replaces the lower picture. A timeline backdrop prevents
  // Resolve from blending the same translucent footage a second time.
  const replacesPicture = layer.clips.some(
    (clip) => clip.adjustment && clip.grade,
  );
  // Titles and scenes keep transparency around their own picture.
  const id = parsed.root.attrs["data-composition-id"];
  const clear = replacesPicture
    ? "<style>html{background-color:#000}</style>"
    : `<style>html,body${id ? `,[data-composition-id=${cssString(id)}]` : ""}{background:transparent!important}</style>`;
  const html = applyTrackMix({
    ...parsed,
    timeline: {
      ...timeline,
      tracks: timeline.tracks.map((track) => ({
        ...track,
        muted: true,
        solo: false,
      })),
      clips: timeline.clips.map((clip) =>
        shows(clip) ? clip : { ...clip, enabled: false },
      ),
    },
  });
  return /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, () => `${clear}</head>`)
    : `${clear}${html}`;
}

/** A CSS string; `<` is escaped too, so the value can never close the style element. */
const cssString = (value: string) =>
  `"${value.replace(/[\0-\x1f\x7f"\\<]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `)}"`;
