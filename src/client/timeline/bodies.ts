import { mediaSettings, peakLevels } from "../../shared/media";
import type { Clip, Fps } from "../../shared/timeline/schema";
import {
  clipsInRange,
  filmTiles,
  frameStep,
  mountedRange,
  peakLevel,
  rowsBetween,
  sourceSecondsPerPixel,
} from "./math";
import type { FrameRange, Row, TrackClips } from "./math";
import { PEAK_CHUNK, createTimelineMedia } from "./media";
import type { ViewState } from "./view";

export interface BodyScene {
  rows: readonly Row[];
  tracks: ReadonlyMap<number, TrackClips>;
  fps: Fps;
}
export type Bodies = ReturnType<typeof createBodies>;

/** The view rests this long before single frames are asked for, so a zoom asks once. */
const SETTLE_MS = 150;
/** Height of the sound strip along the bottom of a video clip's filmstrip. */
const BAND = 12;
const BAND_SCRIM = 0.82;
const bucketSeconds = (level: number) =>
  peakLevels[level]! / mediaSettings.peakSampleRate;

/**
 * Draws what is inside clip bodies, filmstrips and waveforms, on one canvas over the lanes. The
 * canvas is two views wide and sits in the scrolling content, so scrolling moves it on the
 * compositor; it is drawn again when the zoom changes, when the view leaves it, and when media
 * arrives. React never renders for any of it.
 */
export function createBodies(
  canvas: HTMLCanvasElement,
  projectId: string,
  composition: string,
) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The timeline canvas has no 2D context.");
  const ctx = context;
  const style = getComputedStyle(canvas);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const tokens = {
    name: parseFloat(token("--size-clip-name")),
    film: parseFloat(token("--size-filmstrip")),
    locked: Number(token("--track-locked-opacity")),
    seam: token("--clip-filmstrip-seam"),
    scrim: token("--clip-video-body"),
    wave: { audio: token("--wave-audio"), video: token("--wave-video") },
  };
  const media = createTimelineMedia(projectId, composition, schedule);

  let scene: BodyScene | null = null;
  let view: ViewState | null = null;
  /** The lanes' pixels the canvas covers, and the zoom it was drawn at. */
  let area: { x: FrameRange; y: FrameRange; ppf: number } | null = null;
  /** Frames the last paint could not show yet, for tiles in view. */
  let wanted: { src: string; time: number }[] = [];
  let queued = 0;
  let resting: ReturnType<typeof setTimeout> | undefined;

  function schedule() {
    queued ||= requestAnimationFrame(() => {
      queued = 0;
      paint();
    });
  }

  function paint() {
    if (!scene || !view || !(view.ppf > 0)) return;
    const { ppf } = view;
    const { fps } = scene;
    const visible = {
      x: { from: view.frames.from * ppf, to: view.frames.to * ppf },
      y: view.rows,
    };
    const kept = area?.ppf === ppf ? area : null;
    area = {
      x: mountedRange(kept?.x ?? null, visible.x),
      y: mountedRange(kept?.y ?? null, visible.y),
      ppf,
    };
    const dpr = devicePixelRatio;
    const left = area.x.from;
    const top = area.y.from;
    const last = scene.rows.at(-1);
    // One size at every zoom and scroll offset: resizing a canvas reallocates it.
    const width = Math.ceil((visible.x.to - visible.x.from) * 2 * dpr);
    const height = Math.ceil(
      Math.min(
        (visible.y.to - visible.y.from) * 2,
        last ? last.top + last.height : 0,
      ) * dpr,
    );
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width / dpr}px`;
      canvas.style.height = `${height / dpr}px`;
    } else ctx.clearRect(0, 0, width, height);
    canvas.style.transform = `translate(${left}px, ${top}px)`;
    const originX = Math.round(left * dpr);
    const originY = Math.round(top * dpr);
    const right = left + width / dpr;
    const bottom = top + height / dpr;
    const hair = Math.max(1, Math.round(dpr));
    wanted = [];
    /** A row's waveform columns by colour, filled once per row. */
    let waves = { audio: new Path2D(), video: new Path2D() };

    /** A clip's sound between device pixels `x0` and `x1`: centred, or as a strip rising from `y1`. */
    function wave(
      clip: Clip,
      src: string,
      x0: number,
      x1: number,
      y0: number,
      y1: number,
      strip: boolean,
    ) {
      const xa = Math.max(x0, 0);
      const xb = Math.min(x1, width);
      if (xb <= xa) return;
      const perPixel = sourceSecondsPerPixel(ppf, fps, clip.playbackRate) / dpr;
      const start = (clip.mediaStart ?? 0) - x0 * perPixel;
      const loaded = (level: number, fetch: boolean) => {
        if (level < 0 || level >= peakLevels.length) return false;
        const chunk = bucketSeconds(level) * PEAK_CHUNK;
        const to = Math.floor((start + xb * perPixel) / chunk);
        let all = true;
        for (
          let at = Math.floor((start + xa * perPixel) / chunk);
          at <= to;
          at++
        )
          all = media.peaks(src, level, at, fetch) !== undefined && all;
        return all;
      };
      const target = peakLevel(perPixel);
      // Until the level for this zoom arrives, a neighbouring one already in memory is drawn.
      const level = loaded(target, true)
        ? target
        : [target + 1, target - 1, target + 2].find((other) =>
            loaded(other, false),
          );
      if (level === undefined) return;
      const perBucket = perPixel / bucketSeconds(level);
      const first = start / bucketSeconds(level);
      const span = y1 - y0;
      const middle = (y0 + y1) / 2;
      if (strip) {
        const alpha = ctx.globalAlpha;
        ctx.globalAlpha = alpha * BAND_SCRIM;
        ctx.fillStyle = tokens.scrim;
        ctx.fillRect(xa, y0, xb - xa, span);
        ctx.globalAlpha = alpha;
      }
      let held = -1;
      let pairs: Int16Array | undefined;
      const bars = waves[clip.kind === "audio" ? "audio" : "video"];
      for (let x = xa; x < xb; x++) {
        const from = Math.floor(first + x * perBucket);
        const to = Math.max(from + 1, Math.floor(first + (x + 1) * perBucket));
        let low = 32767;
        let high = -32768;
        for (let bucket = from; bucket < to; bucket++) {
          const chunk = Math.floor(bucket / PEAK_CHUNK);
          if (chunk !== held) {
            held = chunk;
            pairs = media.peaks(src, level, chunk, false);
          }
          const at = (bucket - chunk * PEAK_CHUNK) * 2;
          // Past the end of the source.
          if (!pairs || at + 1 >= pairs.length) break;
          if (pairs[at]! < low) low = pairs[at]!;
          if (pairs[at + 1]! > high) high = pairs[at + 1]!;
        }
        if (high < low) continue;
        if (strip) {
          // Too short for a centred wave: loudness rises from the bottom edge.
          const tall = Math.round((Math.max(-low, high) / 32768) * span);
          bars.rect(x, y1 - Math.max(1, tall), 1, Math.max(1, tall));
          continue;
        }
        const upper = Math.round(middle - (high / 32768) * (span / 2));
        const lower = Math.round(middle - (low / 32768) * (span / 2));
        bars.rect(x, upper, 1, Math.max(1, lower - upper));
      }
    }

    /** A clip's pictures in tiles from its left edge, cut off at device pixel `x1`. */
    function film(
      clip: Clip,
      src: string,
      x1: number,
      y0: number,
      y1: number,
      inView: boolean,
    ) {
      const start = clip.start * ppf;
      const from = left - start;
      const to = Math.min(right - start, clip.duration * ppf);
      const draw = (
        picture: ImageBitmap,
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        x: number,
        tile: number,
      ) => {
        const at = Math.round((start + x) * dpr) - originX;
        const wide = Math.round((start + x + tile) * dpr) - originX - at;
        const shown = Math.min(wide, x1 - at);
        if (shown <= 0) return;
        ctx.drawImage(
          picture,
          sx,
          sy,
          (sw * shown) / wide,
          sh,
          at,
          y0,
          shown,
          y1 - y0,
        );
        ctx.fillStyle = tokens.seam;
        ctx.fillRect(at, y0, hair, y1 - y0);
      };
      if (clip.kind === "image") {
        const picture = media.still(src);
        if (!picture) return;
        const tile = Math.round((tokens.film * picture.width) / picture.height);
        for (
          let x = Math.max(0, Math.floor(from / tile)) * tile;
          x < to;
          x += tile
        )
          draw(picture, 0, 0, picture.width, picture.height, x, tile);
        return;
      }
      const strip = media.film(src);
      if (!strip) return;
      const tile = Math.round(
        (tokens.film * strip.tileWidth) / strip.tileHeight,
      );
      const perPixel = sourceSecondsPerPixel(ppf, fps, clip.playbackRate);
      const step = frameStep(tile * perPixel);
      const exact = step < mediaSettings.filmstripInterval;
      for (const { x, time } of filmTiles(
        clip,
        tile,
        perPixel,
        step,
        from,
        to,
      )) {
        const frame = exact ? media.frame(src, time) : undefined;
        if (frame) {
          draw(frame, 0, 0, frame.width, frame.height, x, tile);
          continue;
        }
        if (
          exact &&
          inView &&
          (clip.sourceDuration === null || time < clip.sourceDuration) &&
          start + x < visible.x.to &&
          start + x + tile > visible.x.from
        )
          wanted.push({ src, time });
        // The sprite's tile from before this time stands in until the exact frame arrives.
        const index = Math.min(
          strip.count - 1,
          Math.floor(time / mediaSettings.filmstripInterval + 1e-6),
        );
        const sheet =
          strip.sheets[Math.floor(index / mediaSettings.tilesPerSheet)];
        const sprite = sheet && media.sheet(sheet.spriteUrl);
        if (!sprite) continue;
        const cell = index - sheet.start;
        draw(
          sprite,
          (cell % sheet.columns) * strip.tileWidth,
          Math.floor(cell / sheet.columns) * strip.tileHeight,
          strip.tileWidth,
          strip.tileHeight,
          x,
          tile,
        );
      }
    }

    const frames = { from: left / ppf, to: right / ppf };
    for (const row of rowsBetween(scene.rows, top, bottom)) {
      const track = scene.tracks.get(row.track.index);
      if (!track) continue;
      const y0 = Math.round((row.top + 1 + tokens.name) * dpr) - originY;
      const y1 = Math.round((row.top + row.height - 1) * dpr) - originY;
      const inView =
        row.top < visible.y.to && row.top + row.height > visible.y.from;
      ctx.globalAlpha = row.track.locked ? tokens.locked : 1;
      waves = { audio: new Path2D(), video: new Path2D() };
      const corners: number[] = [];
      for (const clip of clipsInRange(track, frames)) {
        if (clip.src === null) continue;
        const pictured =
          row.track.kind === "video" &&
          (clip.kind === "video" || clip.kind === "image");
        if (!pictured && !clip.hasAudio) continue;
        // The clip's box as the browser snaps it: a pixel short of the next clip.
        const x0 = Math.round(clip.start * ppf * dpr) - originX;
        const x1 = Math.max(
          x0 + hair,
          Math.round(((clip.start + clip.duration) * ppf - 1) * dpr) - originX,
        );
        if (pictured) film(clip, clip.src, x1, y0, y1, inView);
        if (clip.hasAudio)
          wave(
            clip,
            clip.src,
            x0,
            x1,
            pictured ? y1 - Math.round(BAND * dpr) : y0,
            y1,
            pictured,
          );
        if (!pictured) continue;
        corners.push(x0, x1 - hair);
      }
      for (const kind of ["audio", "video"] as const) {
        ctx.fillStyle = tokens.wave[kind];
        ctx.fill(waves[kind]);
      }
      // The clips' rounded bottom corners, which square tiles and strips would cover.
      for (const x of corners) ctx.clearRect(x, y1 - hair, hair, hair);
    }
  }

  return {
    /** The clips to draw. */
    scene(next: BodyScene) {
      scene = next;
      paint();
    },
    /** Follows a zoom, scroll or resize. Cheap while the canvas still covers the view. */
    view(next: ViewState) {
      const covered =
        area &&
        area.ppf === next.ppf &&
        area.x.from <= next.frames.from * next.ppf &&
        area.x.to >= next.frames.to * next.ppf &&
        area.y.from <= next.rows.from &&
        area.y.to >= next.rows.to;
      view = next;
      if (!covered) paint();
      clearTimeout(resting);
      resting = setTimeout(() => {
        paint();
        media.wantFrames(wanted);
      }, SETTLE_MS);
    },
    destroy() {
      cancelAnimationFrame(queued);
      clearTimeout(resting);
      media.dispose();
    },
  };
}
