export const mediaSettings = {
  peakSampleRate: 48000,
  peakBucketSamples: 96,
  mipFactor: 4,
  coarseSeconds: 4,
  tileHeight: 90,
  filmstripInterval: 2,
  columns: 10,
  tilesPerSheet: 100,
  jpegQuality: 4,
} as const;

export const peakLevels = (() => {
  const levels: number[] = [mediaSettings.peakBucketSamples];
  while (
    levels.at(-1)! / mediaSettings.peakSampleRate <
    mediaSettings.coarseSeconds
  )
    levels.push(levels.at(-1)! * mediaSettings.mipFactor);
  return Object.freeze(levels);
})();

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
