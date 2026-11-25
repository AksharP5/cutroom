import { mediaSettings } from "../../shared/media";

export function tileWidth(video: {
  width: number;
  height: number;
  pixelAspect: number;
}) {
  return Math.max(
    2,
    Math.round(
      (video.width * video.pixelAspect * mediaSettings.tileHeight) /
        video.height /
        2,
    ) * 2,
  );
}
export function scaleFilter(video: {
  width: number;
  height: number;
  pixelAspect: number;
}) {
  return `scale=${tileWidth(video)}:${mediaSettings.tileHeight},setsar=1`;
}

/** The displayed picture in square pixels, its shorter side at most `lines`, never enlarged. */
function capped(
  video: { width: number; height: number; pixelAspect: number },
  lines: number,
) {
  const width = video.width * video.pixelAspect;
  const scale = Math.min(1, lines / Math.min(width, video.height));
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return `scale=${even(width * scale)}:${even(video.height * scale)},setsar=1`;
}
/** Scrub proxies: small enough that a frame decodes at once while dragging. */
export const scrubFilter = (video: Parameters<typeof capped>[0]) =>
  capped(video, 540);
/**
 * Editing proxies keep the source's own size up to 1080 lines. Larger sources play at 1080p:
 * the viewer is smaller than that, Chromium decodes H.264 in software, and export reads the
 * source.
 */
export const proxyFilter = (video: Parameters<typeof capped>[0]) =>
  capped(video, 1080);
