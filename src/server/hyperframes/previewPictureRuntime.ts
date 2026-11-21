// Bundled for the isolated composition document, which cannot import the editor.
import { resolveRateSpec } from "@hyperframes/core/speed-ramp";
import { attrMicros } from "../../shared/timeline/piece";
import {
  pictureClockCache,
  PreviewPicturesSchema,
  pictureFor,
  pictureInterval,
  unpackTime,
} from "../../shared/timeline/pictureClock";
import { SourceDecoder, videoTrackColour } from "../../shared/video/decoder";
import { openRanges, readVideoTrack } from "../../shared/video/mp4";
import { pictureSample } from "../../shared/video/pictureSample";
import type { PictureClock, PreviewPictures } from "../../shared/timeline/pictureClock";

type RestingTarget = ReturnType<typeof pictureInterval> & {
  clock: PictureClock;
  ordinal: number;
};

export const previewPictureRuntime = {
  pictureClockCache,
  readPlan(value: unknown) {
    const result = PreviewPicturesSchema.safeParse(value);
    return result.success ? result.data : null;
  },
  pictureForTime(
    pictures: PreviewPictures,
    entry: PreviewPictures["pieces"][number],
    clock: PictureClock,
    time: number,
  ) {
    const { fps } = pictures;
    const start = unpackTime(entry.start);
    const anchor = unpackTime(entry.anchor);
    const curve = resolveRateSpec(entry.automation, entry.curve ?? 1);
    const ordinal = pictureFor(
      clock,
      {
        id: entry.id,
        src: entry.src,
        path: "",
        ownFps: fps,
        origin: anchor,
        local: { start, end: start },
        edge: { start: anchor, end: anchor },
        curve,
        stored: {
          mediaStart: entry.mediaStart,
          ...(typeof curve === "object" &&
            curve.offset !== undefined && {
              offset: Number(attrMicros(curve.offset)),
            }),
        },
        loop: entry.loop,
      },
      fps,
      Math.round((time * fps.num) / fps.den),
    );
    return ordinal === null
      ? null
      : { ordinal, clock, ...pictureInterval(clock, ordinal) };
  },
  /** A native seek can land after an open GOP's leading pictures. Decode from their references. */
  async recoverPicture(
    video: HTMLVideoElement,
    target: RestingTarget,
    signal: AbortSignal,
  ) {
    const url = new URL(video.currentSrc || video.src);
    if (
      url.search ||
      !/\.(mp4|m4v|mov)$/i.test(url.pathname) ||
      video.videoWidth * video.videoHeight > 1920 * 1080
    )
      return null;
    const { read, size } = await openRanges(url.href, signal, true);
    const track = await readVideoTrack(read, size);
    if (
      track.rotation ||
      track.width * track.height > 1920 * 1080 ||
      !(await SourceDecoder.supported(track))
    )
      return null;
    signal.throwIfAborted();
    const decoder = SourceDecoder.forTrack(
      track,
      read,
      size,
      videoTrackColour(track),
      false,
      2,
    )();
    const aborted = Promise.withResolvers<null>();
    const cancel = () => aborted.resolve(null);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const { index, timestamp } = pictureSample(
        decoder,
        target.clock,
        target.ordinal,
      );
      const requested = decoder.frame(index);
      const frame = await Promise.race([requested, aborted.promise]);
      if (!frame) {
        void requested.then(
          (late) => late.close(),
          () => {},
        );
        return null;
      }
      if (frame.timestamp === timestamp && !signal.aborted) return frame;
      frame.close();
      return null;
    } finally {
      signal.removeEventListener("abort", cancel);
      decoder.close();
    }
  },
};
Object.assign(window, { __cutroomPictureRuntime: previewPictureRuntime });
