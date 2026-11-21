import { expect, test } from "bun:test";
import { transitionSourceTimes } from "../src/server/timeline/transitionSource";

test("NTSC transition source correction leaves authored ramp in-points intact", () => {
  const video =
    '<video data-transition-in="dissolve" data-transition-in-align="center" data-media-start="0.033367"></video>';
  const ramp = video.replace(
    "<video",
    `<video data-automation='{"version":1,"lanes":[{"target":"rate","offset":0.5,"points":[{"t":0,"v":1},{"t":1,"v":2}]}]}'`,
  );
  const html = `<main data-fps="30000/1001">${video}${ramp}</main>`;
  expect(transitionSourceTimes(html)).toBe(
    html.replace(video, video.replace("0.033367", String(1001 / 30_000))),
  );
});
