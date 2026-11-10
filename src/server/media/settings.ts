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
