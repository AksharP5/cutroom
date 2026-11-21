import { pictureInterval } from "../timeline/pictureClock";
import type { PictureClock } from "../timeline/pictureClock";
import type { SourceDecoder } from "./decoder";

/** The MP4 table can include edit-list preroll the export index omits. */
export function pictureSample(
  decoder: SourceDecoder,
  clock: PictureClock,
  ordinal: number,
) {
  const first = pictureInterval(clock, 0);
  const index = decoder.indexAt(first.start + first.tolerance) + ordinal;
  const timestamp = decoder.timestampAt(index);
  const target = pictureInterval(clock, ordinal);
  if (
    timestamp === undefined ||
    Math.abs(timestamp / 1e6 - target.start) > target.tolerance
  )
    throw new Error(
      "The footage sample table disagrees with the export picture index.",
    );
  return { index, timestamp };
}
