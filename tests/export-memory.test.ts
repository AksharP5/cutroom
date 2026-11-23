import { expect, test } from "bun:test";
import { planCaptureBrowsers } from "../src/server/hyperframes/exportMemory";
import {
  captureDocument,
  countCaptureMedia,
  loadedMedia,
  timedCaptureMedia,
} from "../src/server/hyperframes/captureWorkload";

const GiB = 1024 ** 3;

test("capture memory follows selected runs in export time, including transition handles", () => {
  const html = `<!doctype html><html><head></head><body><main data-composition-id="main">
  <video data-start="0" data-duration="2.2"></video>
  <video data-start="1.8" data-duration="2.2"></video>
  <audio data-start="8" data-duration="2"></audio>
  <video data-start="16" data-duration="2"></video>
  </main></body></html>`;
  const workload = {
    mediaClips: 4,
    durationFrames: 540,
    fps: { num: 30, den: 1 },
    timedMedia: timedCaptureMedia(html),
  };
  const fps = { num: 60, den: 1 };
  const runs = [
    { start: 120, end: 125 },
    { start: 970, end: 975 },
  ];
  expect(countCaptureMedia(workload, fps, runs)).toBe(3);
  expect(countCaptureMedia(workload, fps, [{ start: 550, end: 575 }])).toBe(1);
  expect(countCaptureMedia(workload, fps, undefined)).toBe(4);
  const scripted = html.replace(
    "</head>",
    "<script>document.querySelector('video').play()</script></head>",
  );
  expect(
    countCaptureMedia(
      { ...workload, timedMedia: timedCaptureMedia(scripted) },
      fps,
      runs,
    ),
  ).toBe(4);
});

test("a capture document keeps only the pictures its runs show, and all of its sound", () => {
  const html = `<!doctype html><html><head></head><body><main data-composition-id="main">
  <video id="early" data-start="0" data-duration="10"></video>
  <video id="intro" data-start="0" data-duration="8"></video>
  <video id="under" data-start="10" data-duration="10"></video>
  <video id="late" data-start="20" data-duration="10" data-transition-in="dissolve" data-transition-in-duration="1"></video>
  <video id="after" data-start="40" data-duration="10"></video>
  <img id="still" data-start="0" data-duration="5">
  <audio id="sound" data-start="0" data-duration="50"></audio>
  <div id="title" class="clip" data-start="intro + 10" data-duration="1.5"><span>Title</span></div>
  </main></body></html>`;
  // A title from 18 s to 19.5 s at 60 fps.
  const kept = captureDocument(html, [{ start: 1080, end: 1170 }], {
    num: 60,
    den: 1,
  });
  expect(
    [...kept.matchAll(/ id="([a-z]+)"/g)].map((match) => match[1]),
  ).toEqual(
    // The dissolve into "late" can show it a second early.
    ["intro", "under", "late", "sound", "title"],
  );
  expect(kept).toContain(
    '<div id="title" class="clip" data-start="intro + 10"',
  );
});

test("capture browsers are charged for the media they load, not disabled clips or refused sound", () => {
  const html = `<!doctype html><html><head></head><body><main data-composition-id="main">
  <video data-start="0" data-duration="2"></video>
  <video data-start="2" data-duration="2" data-hidden></video>
  <audio data-start="0" data-duration="4"></audio>
  <div data-hidden><video data-start="4" data-duration="2"></video></div>
  </main></body></html>`;
  expect(loadedMedia(html, true)).toBe(2);
  expect(loadedMedia(html, false)).toBe(1);
});

test("a 280-clip timeline starts one capture browser where HyperFrames started five", () => {
  // Five started with 14 GiB free and took the machine to 3 GiB within seconds.
  expect(
    planCaptureBrowsers({ available: 14 * GiB, mediaClips: 280, frames: 150 }),
  ).toEqual({ browsers: 1 });
});

test("an export that would exhaust memory is refused with what it needs", () => {
  const plan = planCaptureBrowsers({
    available: 5 * GiB,
    mediaClips: 280,
    frames: 150,
  });
  expect(plan).toEqual({
    refusal:
      "This export needs about 7.3 GB of free memory and 5.0 GB is free. Close other apps and try again.",
  });
});

test("a short range uses two browsers, a long one on a light timeline more", () => {
  const light = { available: 14 * GiB, mediaClips: 16 };
  expect(planCaptureBrowsers({ ...light, frames: 150 })).toEqual({
    browsers: 2,
  });
  expect(planCaptureBrowsers({ ...light, frames: 30 })).toEqual({
    browsers: 1,
  });
  const long = planCaptureBrowsers({ ...light, frames: 1350 });
  expect("browsers" in long && long.browsers).toBeGreaterThan(2);
});

test("browsers capturing beside FFmpeg's source encoders leave room for them", () => {
  // A 280-clip timeline at 1080p, where some frames draw from the sources.
  const plan = { available: 7.5 * GiB, mediaClips: 280, frames: 150 };
  expect(planCaptureBrowsers(plan)).toEqual({ browsers: 1 });
  expect(
    planCaptureBrowsers({ ...plan, sourcePixels: 1920 * 1080 }),
  ).toHaveProperty("refusal");
});

test("a long timeline with short captured runs accounts for its inactive media", () => {
  expect(
    planCaptureBrowsers({
      available: 13 * GiB,
      mediaClips: 60,
      mediaClipsOutsideRange: 978,
      frames: 720,
      sourcePixels: 1920 * 1080,
    }),
  ).toEqual({ browsers: 1 });
});

test("a 4K export leaves room for its encoder, which ProRes needs most of", () => {
  // At 4K the encoder held 2.3 GB for H.264 and 4.0 GB for ProRes beside the browsers.
  const plan = { mediaClips: 2, frames: 150 };
  const uhd = 3840 * 2160;
  expect(
    planCaptureBrowsers({
      ...plan,
      available: 6 * GiB,
      outputPixels: 1920 * 1080,
    }),
  ).toEqual({ browsers: 2 });
  expect(
    planCaptureBrowsers({ ...plan, available: 6 * GiB, outputPixels: uhd }),
  ).toHaveProperty("refusal");
  expect(
    planCaptureBrowsers({ ...plan, available: 8 * GiB, outputPixels: uhd }),
  ).toEqual({ browsers: 2 });
  expect(
    planCaptureBrowsers({
      ...plan,
      available: 8 * GiB,
      outputPixels: uhd,
      prores: true,
    }),
  ).toEqual({ browsers: 1 });
});
