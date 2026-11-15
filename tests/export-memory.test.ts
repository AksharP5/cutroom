import { expect, test } from "bun:test";
import { planCaptureBrowsers } from "../src/server/hyperframes/exportMemory";

const GiB = 1024 ** 3;

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
