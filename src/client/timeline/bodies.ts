import {
  rampSourceSeconds,
  readClipSource,
} from "../../shared/timeline/clipTiming";
import { mediaSettings, peakLevels } from "../../shared/media";
import type { Clip, Fps } from "../../shared/timeline/schema";
import { clipEnd } from "../../shared/timeline/apply";
import {
  clipNamed,
  clipRuns,
  clipsInRange,
  RUN_MAX_WIDTH,
  filmTileOffsets,
  frameStep,
  peakLevel,
  rowsBetween,
  sourceSecondsPerPixel,
  tileTime,
} from "./math";
import type { FrameRange, Row, TrackClips } from "./math";
import { PEAK_CHUNK, createTimelineMedia } from "./media";
import { volumeLane, waveformScale } from "./mix";
import { clipFades } from "../../shared/timeline/mix";
import type { ViewState } from "./view";
import { clipVisible } from "../../shared/timeline/tracks";
import type { TrackMix } from "../../shared/timeline/tracks";

export interface BodyScene {
  rows: readonly Row[];
  tracks: ReadonlyMap<number, TrackClips>;
  fps: Fps;
  imageSources: ReadonlyMap<string, string>;
  mix: TrackMix;
  /** Clips whose file is gone. Their boxes say so, and nothing is drawn over them. */
  offline: ReadonlySet<string>;
}
export type Bodies = ReturnType<typeof createBodies>;
/** A clip's way from where it was drawn to where it is, as its box takes it. */
export interface Slide {
  id: string;
  x: number;
  y: number;
  duration: number;
  /** Progress at a fraction of the duration, from 0 to 1. */
  ease(time: number): number;
}

/** Waveform columns for one row, by whether their clip is on, and by colour. */
const paths = () => ({
  on: { audio: new Path2D(), video: new Path2D(), voiceover: new Path2D() },
  off: { audio: new Path2D(), video: new Path2D(), voiceover: new Path2D() },
});

/** The view rests this long before single frames are asked for, so a zoom asks once. */
const SETTLE_MS = 150;
/** Height of the sound strip along the bottom of a video clip's filmstrip. */
const BAND = 12;
const BAND_SCRIM = 0.82;
const NO_FADES = { fadeIn: 0, fadeOut: 0 };
const bucketSeconds = (level: number) =>
  peakLevels[level]! / mediaSettings.peakSampleRate;

/**
 * Draws what is inside clip bodies, filmstrips and waveforms, on one canvas over the lanes. The
 * canvas is two views wide and sits in the scrolling content, so scrolling moves it on the
 * compositor; it is drawn again when the zoom changes, when the view leaves it, and when media
 * arrives. React never renders for any of it.
 *
 * A clip draws by its width. With room for a name (`clipNamed`) its picture sits under the name
 * strip. Narrower, the picture takes the whole height under the rail and shows the middle of its
 * frame. A run of narrow clips from one source averaging under 6px draws as one
 * filmstrip and one waveform under their rails, so the picture and sound continue across cuts
 * at Fit.
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
    rail: parseFloat(token("--stroke-rail")),
    locked: Number(token("--track-locked-opacity")),
    seam: token("--clip-filmstrip-seam"),
    scrim: token("--clip-video-body"),
    body: {
      video: token("--clip-video-body"),
      image: token("--clip-image-body"),
      audio: token("--clip-audio-body"),
      voiceover: token("--clip-vo-body"),
      composition: token("--clip-comp-body"),
      element: token("--clip-comp-body"),
    } satisfies Record<Clip["kind"], string>,
    wave: {
      audio: token("--wave-audio"),
      video: token("--wave-video"),
      voiceover: token("--wave-vo"),
    },
    off: {
      filter: token("--clip-disabled-filter"),
      opacity: Number(token("--clip-disabled-opacity")),
    },
  };
  let media = createTimelineMedia(projectId, composition, schedule);

  let scene: BodyScene | null = null;
  let view: ViewState | null = null;
  /** The lanes' pixels the canvas covers, and the zoom it was drawn at. */
  let area: { x: FrameRange; y: FrameRange; ppf: number } | null = null;
  /** Frames the last paint could not show yet, for tiles in view. */
  let wanted: { src: string; time: number }[] = [];
  let queued = 0;
  /** Set once the view has rested; a zoom or scroll clears it and stops frame requests. */
  let settled = false;
  let resting: ReturnType<typeof setTimeout> | undefined;
  /** Clips an edit moved, drawn from where they were towards where they are, with their boxes. */
  let slides: (Slide & { at: number })[] = [];
  let sliding = 0;

  function slideFrame() {
    const now = performance.now();
    slides = slides.filter((slide) => now - slide.at < slide.duration);
    paint();
    sliding = slides.length ? requestAnimationFrame(slideFrame) : 0;
  }

  /** Media arrived: draw it, and ask for the exact frames it makes drawable if the view is at rest. */
  function schedule() {
    queued ||= requestAnimationFrame(() => {
      queued = 0;
      paint();
      if (settled) media.wantFrames(wanted);
    });
  }

  /**
   * Two viewports in each direction. Keep the allocation while track heights change.
   */
  function fit({ ppf, frames, rows }: ViewState) {
    const dpr = devicePixelRatio;
    const visible = {
      x: { from: frames.from * ppf, to: frames.to * ppf },
      y: rows,
    };
    // The view is whole pixels; rounding keeps arithmetic noise from changing the size.
    const wide = Math.round(visible.x.to - visible.x.from);
    const tall = Math.round(visible.y.to - visible.y.from);
    return {
      dpr,
      visible,
      width: Math.ceil(wide * 2 * dpr),
      height: Math.ceil(tall * 2 * dpr),
    };
  }
  /** Whether the canvas as drawn still shows everything in a view. */
  const covers = (
    next: ViewState,
    { visible, width, height }: ReturnType<typeof fit>,
  ) =>
    area !== null &&
    area.ppf === next.ppf &&
    canvas.width === width &&
    canvas.height === height &&
    area.x.from <= visible.x.from &&
    area.x.to >= visible.x.to &&
    area.y.from <= visible.y.from &&
    area.y.to >= visible.y.to;
  /** Where a canvas `size` long starts so the visible range sits in its middle. */
  const centred = (visible: FrameRange, size: number, content = Infinity) =>
    Math.max(
      0,
      Math.min(
        Math.floor(visible.from - (size - (visible.to - visible.from)) / 2),
        content - size,
      ),
    );

  function paint() {
    if (!scene || !view || !(view.ppf > 0)) return;
    const { ppf } = view;
    const { fps } = scene;
    const last = scene.rows.at(-1);
    const tracks = last ? last.top + last.height : 0;
    const needed = fit(view);
    const { dpr, visible, width, height } = needed;
    // The canvas stays where it is while it still covers the view.
    const kept = covers(view, needed) ? area : null;
    const left = kept?.x.from ?? centred(visible.x, width / dpr);
    const top = kept?.y.from ?? centred(visible.y, height / dpr, tracks);
    const right = left + width / dpr;
    const bottom = top + height / dpr;
    area = { x: { from: left, to: right }, y: { from: top, to: bottom }, ppf };
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width / dpr}px`;
      canvas.style.height = `${height / dpr}px`;
    } else ctx.clearRect(0, 0, width, height);
    canvas.style.transform = `translate(${left}px, ${top}px)`;
    const originX = Math.round(left * dpr);
    const originY = Math.round(top * dpr);
    const hair = Math.max(1, Math.round(dpr));
    wanted = [];
    const now = performance.now();
    // Sum overlapping slides once per paint. A ripple can move every visible clip.
    const offsets = new Map<string, { x: number; y: number }>();
    for (const slide of slides) {
      const left =
        1 - slide.ease(Math.min(1, (now - slide.at) / slide.duration));
      const offset = offsets.get(slide.id);
      if (offset) {
        offset.x += slide.x * left;
        offset.y += slide.y * left;
      } else {
        offsets.set(slide.id, { x: slide.x * left, y: slide.y * left });
      }
    }
    media.beginPaint(settled);
    /** A row's waveform columns by colour, filled once per row. */
    let waves = paths();

    /**
     * A clip's sound between device pixels `x0` and `x1`: centred, or as a strip rising from `y1`.
     * A clip in a run starts at `from`, over the seam its neighbour leaves.
     */
    function wave(
      clip: Clip,
      src: string,
      x0: number,
      x1: number,
      y0: number,
      y1: number,
      strip: boolean,
      from = x0,
    ) {
      const xa = Math.max(from, 0);
      const xb = Math.min(x1, width);
      if (xb <= xa) return;
      // The seam plays what the clip's first column does.
      const xr = Math.max(xa, x0);
      const perPixel = sourceSecondsPerPixel(ppf, fps, clip.playbackRate) / dpr;
      const start = (clip.mediaStart ?? 0) - x0 * perPixel;
      // A ramp reads each column's edges off the clip's own curve, one entry per edge.
      const ramp = rampSourceSeconds(
        clip,
        fps,
        (xr - x0) / (ppf * dpr),
        sourceSecondsPerPixel(ppf, fps, 1) / dpr,
        xb - xr + 1,
      );
      const sourceAt = (x: number) =>
        ramp ? ramp[Math.max(x, xr) - xr]! : start + x * perPixel;
      const loaded = (level: number, fetch: boolean) => {
        if (level < 0 || level >= peakLevels.length) return false;
        const chunk = bucketSeconds(level) * PEAK_CHUNK;
        const to = Math.floor(Math.max(sourceAt(xa), sourceAt(xb)) / chunk);
        let all = true;
        for (
          let at = Math.floor(Math.min(sourceAt(xa), sourceAt(xb)) / chunk);
          at <= to;
          at++
        )
          all = media.peaks(src, level, at, fetch) !== undefined && all;
        return all;
      };
      const target = peakLevel(
        ramp ? (sourceAt(xb) - sourceAt(xa)) / (xb - xa) : perPixel,
      );
      // Until the level for this zoom arrives, a neighbouring one already in memory is drawn.
      const level = loaded(target, true)
        ? target
        : [target + 1, target - 1, target + 2].find((other) =>
            loaded(other, false),
          );
      if (level === undefined) return;
      // The wave grows and shrinks with the gain line, down to a floor, and tapers under a fade.
      const fades = clip.fadeIn || clip.fadeOut ? clipFades(clip) : NO_FADES;
      const lane = volumeLane(clip);
      const framesPerPixel = 1 / (ppf * dpr);
      const bucketLength = bucketSeconds(level);
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
      let pairs: Float32Array | undefined;
      const bars =
        waves[clip.enabled ? "on" : "off"][
          clip.kind === "voiceover"
            ? "voiceover"
            : clip.kind === "audio"
              ? "audio"
              : "video"
        ];
      for (let x = xa; x < xb; x++) {
        const from = Math.floor(sourceAt(x) / bucketLength);
        const to = Math.max(
          from + 1,
          Math.floor(sourceAt(x + 1) / bucketLength),
        );
        let low = Infinity;
        let high = -Infinity;
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
        const gain = waveformScale(
          clip,
          fps,
          Math.max(0, x - x0) * framesPerPixel,
          lane,
          fades,
        );
        // A boosted peak stops at the body's edge.
        const top = Math.min(1, high * gain);
        const bottom = Math.max(-1, low * gain);
        if (strip) {
          // Too short for a centred wave: loudness rises from the bottom edge.
          const tall = Math.round(Math.max(-bottom, top) * span);
          bars.rect(x, y1 - Math.max(1, tall), 1, Math.max(1, tall));
          continue;
        }
        const upper = Math.round(middle - top * (span / 2));
        const lower = Math.round(middle - bottom * (span / 2));
        bars.rect(x, upper, 1, Math.max(1, lower - upper));
      }
    }

    /**
     * Pictures in tiles from the left edge of `parts`, cut off at device pixel `x1`: one clip, or
     * a run of clips from one source that touch. Each tile shows what plays under its left edge.
     * With `middle`, a clip narrower than a tile shows the middle of its frame, where the subject
     * of a talking head sits.
     */
    function film(
      parts: readonly Clip[],
      src: string,
      x1: number,
      y0: number,
      y1: number,
      inView: boolean,
      middle: boolean,
    ) {
      const first = parts[0]!;
      const start = first.start * ppf;
      const length = (clipEnd(parts.at(-1)!) - first.start) * ppf;
      const from = left - start;
      const to = Math.min(right - start, length);
      const draw = (
        clip: Clip,
        picture: ImageBitmap,
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        x: number,
        tile: number,
        requireGrade = false,
      ) => {
        const at = Math.round((start + x) * dpr) - originX;
        const wide = Math.round((start + x + tile) * dpr) - originX - at;
        const shown = Math.min(wide, x1 - at);
        if (shown <= 0) return true;
        const grade = clip.grade && media.grade(clip.grade);
        const graded = grade
          ? media.grades.tile(
              clip.id,
              picture,
              [sx, sy, sw, sh],
              grade,
              inView &&
                start + x < visible.x.to &&
                start + x + tile > visible.x.from,
            )
          : undefined;
        if (requireGrade && !graded) return false;
        const centred = middle && shown < wide;
        ctx.drawImage(
          graded ?? picture,
          (graded ? 0 : sx) + (centred ? (sw * (wide - shown)) / wide / 2 : 0),
          graded ? 0 : sy,
          (sw * shown) / wide,
          sh,
          at,
          y0,
          shown,
          y1 - y0,
        );
        // The ground between two narrow clips already parts them.
        if (centred) return true;
        ctx.fillStyle = tokens.seam;
        ctx.fillRect(at, y0, hair, y1 - y0);
        return true;
      };
      if (first.kind === "image") {
        const picture = media.still(src);
        if (!picture) return;
        const tile = Math.max(
          1,
          Math.round((((y1 - y0) / dpr) * picture.width) / picture.height),
        );
        for (const x of filmTileOffsets(tile, from, to))
          draw(first, picture, 0, 0, picture.width, picture.height, x, tile);
        return;
      }
      const strip = media.film(src);
      if (!strip) return;
      const tile = Math.round(
        (((y1 - y0) / dpr) * strip.tileWidth) / strip.tileHeight,
      );
      let part = 0;
      for (const x of filmTileOffsets(tile, from, to)) {
        while (
          part < parts.length - 1 &&
          (clipEnd(parts[part]!) - first.start) * ppf <= x
        )
          part++;
        const clip = parts[part]!;
        // Pixels from this clip's own left edge to the tile's.
        const inside = Math.max(0, x - (clip.start - first.start) * ppf);
        const perPixel = sourceSecondsPerPixel(ppf, fps, clip.playbackRate);
        const step = frameStep(tile * perPixel);
        const exact = step < mediaSettings.filmstripInterval;
        // A ramp's tile shows what plays under its left edge, read off the clip's own curve.
        const ramped = !!clip.automation && !!readClipSource(clip).lane;
        const time = tileTime(
          clip,
          inside,
          perPixel,
          step,
          ramped
            ? (x) => rampSourceSeconds(clip, fps, x / ppf, 0, 1)![0]!
            : undefined,
        );
        const frame = exact ? media.frame(src, time) : undefined;
        if (
          frame &&
          draw(
            clip,
            frame,
            0,
            0,
            frame.width,
            frame.height,
            x,
            tile,
            !!clip.grade,
          )
        ) {
          continue;
        }
        if (
          exact &&
          !frame &&
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
        if (!sprite) {
          if (frame)
            draw(clip, frame, 0, 0, frame.width, frame.height, x, tile);
          continue;
        }
        const cell = index - sheet.start;
        draw(
          clip,
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
      const under = (strip: number) =>
        Math.round((row.top + 1 + strip) * dpr) - originY;
      // Sound has no name strip: its waveform takes the lane under the kind rail.
      const strip = under(
        row.track.kind === "audio" ? tokens.rail : tokens.name,
      );
      const bare = under(tokens.rail);
      const y1 = Math.round((row.top + row.height - 1) * dpr) - originY;
      const inView =
        row.top < visible.y.to && row.top + row.height > visible.y.from;
      const alpha = row.track.locked ? tokens.locked : 1;
      ctx.globalAlpha = alpha;
      waves = paths();
      const corners: [number, number][] = [];
      /** A clip that is off is grey and dimmed, as its box is. */
      const dim = (off: boolean) => {
        ctx.filter = off ? tokens.off.filter : "none";
        ctx.globalAlpha = alpha * (off ? tokens.off.opacity : 1);
      };
      /** The clip's box as the browser snaps it: a pixel short of the next clip. */
      const box = (clip: Clip) => {
        const x0 = Math.round(clip.start * ppf * dpr) - originX;
        return {
          x0,
          x1: Math.max(
            x0 + hair,
            Math.round(((clip.start + clip.duration) * ppf - 1) * dpr) -
              originX,
          ),
        };
      };
      const pictures = (clip: Clip) =>
        row.track.kind === "video" &&
        (clip.kind === "video" || clip.kind === "image");
      // Runs of narrow clips draw as one body until an edit animates the individual clips.
      const joined = new Set<Clip>();
      for (const run of offsets.size ? [] : clipRuns(track.clips, ppf)) {
        const { first } = run;
        const { src } = first;
        const pictured = pictures(first);
        if (
          (run.end - run.start) * ppf >= RUN_MAX_WIDTH * run.clips.length ||
          run.end <= frames.from ||
          run.start >= frames.to ||
          src === null ||
          scene.offline.has(first.id) ||
          (!pictured && !first.hasAudio)
        )
          continue;
        const parts = run.clips.filter(
          (clip) => clipEnd(clip) > frames.from && clip.start < frames.to,
        );
        const boxes = parts.map(box);
        dim(!clipVisible(first, scene.mix));
        // The seams between the boxes take the body's colour: one body under a rail of cuts.
        ctx.fillStyle = tokens.body[first.kind];
        for (const [index, { x0 }] of boxes.entries()) {
          joined.add(parts[index]!);
          if (index)
            ctx.fillRect(
              boxes[index - 1]!.x1,
              bare,
              x0 - boxes[index - 1]!.x1,
              y1 - bare,
            );
        }
        const end = boxes.at(-1)!.x1;
        if (pictured) film(run.clips, src, end, bare, y1, inView, false);
        dim(false);
        for (const [index, clip] of parts.entries())
          if (clip.hasAudio)
            wave(
              clipVisible(clip, scene.mix) === clip.enabled
                ? clip
                : { ...clip, enabled: false },
              src,
              boxes[index]!.x0,
              boxes[index]!.x1,
              pictured ? y1 - Math.round(BAND * dpr) : bare,
              y1,
              pictured,
              boxes[index - 1]?.x1,
            );
        if (pictured) corners.push([boxes[0]!.x0, y1], [end - hair, y1]);
      }
      for (const placed of clipsInRange(track, frames)) {
        if (joined.has(placed) || scene.offline.has(placed.id)) continue;
        const image = placed.variableBindings?.image;
        const src =
          (image ? scene.imageSources.get(image) : undefined) ?? placed.src;
        if (src === null) continue;
        const pictured = pictures(placed);
        if (!pictured && !placed.hasAudio) continue;
        // A clip an edit moved is drawn where its box is on its way there.
        const shift = offsets.get(placed.id);
        const x = shift?.x ?? 0;
        const enabled = clipVisible(placed, scene.mix);
        const clip =
          x || enabled !== placed.enabled
            ? { ...placed, start: placed.start + x / ppf, enabled }
            : placed;
        const { x0, x1 } = box(clip);
        const named = clipNamed(placed.duration, ppf);
        const down = Math.round((shift?.y ?? 0) * dpr);
        const clipTop = (named ? strip : bare) + down;
        const clipBottom = y1 + down;
        if (pictured) {
          dim(!clip.enabled);
          film([clip], src, x1, clipTop, clipBottom, inView, !named);
          dim(false);
        }
        if (clip.hasAudio)
          wave(
            clip,
            src,
            x0,
            x1,
            pictured ? clipBottom - Math.round(BAND * dpr) : clipTop,
            clipBottom,
            pictured,
          );
        if (!pictured) continue;
        corners.push([x0, clipBottom], [x1 - hair, clipBottom]);
      }
      for (const state of ["on", "off"] as const)
        for (const kind of ["audio", "video", "voiceover"] as const) {
          dim(state === "off");
          ctx.fillStyle = tokens.wave[kind];
          ctx.fill(waves[state][kind]);
        }
      dim(false);
      // The clips' rounded bottom corners, which square tiles and strips would cover.
      for (const [x, y] of corners) ctx.clearRect(x, y - hair, hair, hair);
    }
    media.grades.endPaint();
  }

  return {
    versions(next: Readonly<Record<string, string | null>>) {
      const { mediaChanged, lookChanged } = media.updateVersions(next);
      if (mediaChanged) {
        media.dispose();
        media = createTimelineMedia(projectId, composition, schedule, next);
      }
      if (!mediaChanged && !lookChanged) return;
      paint();
      if (settled) media.wantFrames(wanted);
    },
    /**
     * Clips an edit moved slide from where they were drawn, `x` and `y` CSS pixels away, as their
     * boxes do. Slides that overlap add up, as the boxes' animations do.
     */
    slide(moves: readonly Slide[]) {
      const at = performance.now();
      slides.push(...moves.map((move) => ({ ...move, at })));
      cancelAnimationFrame(sliding);
      slideFrame();
    },
    /** The clips to draw. An edit made while the view rests asks for the frames it uncovers. */
    scene(next: BodyScene) {
      scene = next;
      paint();
      if (settled) media.wantFrames(wanted);
    },
    /**
     * Follows a zoom, scroll or resize. Cheap while the canvas still covers the view. Frames
     * waiting to be asked for are dropped at once and asked for again when the view rests, so
     * a scroll never works through the queue of a view it has left.
     */
    view(next: ViewState) {
      const covered = covers(next, fit(next));
      view = next;
      settled = false;
      media.grades.pause();
      if (!covered) paint();
      media.wantFrames([]);
      clearTimeout(resting);
      resting = setTimeout(() => {
        settled = true;
        paint();
        media.wantFrames(wanted);
      }, SETTLE_MS);
    },
    destroy() {
      cancelAnimationFrame(queued);
      cancelAnimationFrame(sliding);
      clearTimeout(resting);
      media.dispose();
    },
  };
}
