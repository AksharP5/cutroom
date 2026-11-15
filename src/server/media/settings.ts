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

/** Scrub proxies: the shorter side of the displayed picture, never enlarged. */
const scrubLines = 540;
export function scrubFilter(video: {
  width: number;
  height: number;
  pixelAspect: number;
}) {
  const width = video.width * video.pixelAspect;
  const scale = Math.min(1, scrubLines / Math.min(width, video.height));
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return `scale=${even(width * scale)}:${even(video.height * scale)},setsar=1`;
}
