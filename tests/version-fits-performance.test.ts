import { expect, test } from "bun:test";
import { parseComposition } from "../src/server/timeline/composition";
import { applyAll } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";

/** 1,000 linked picture and sound pairs, each with four takes of a measured 60 s file. */
function versionedTimeline(withVersions: boolean) {
  const versions = JSON.stringify(
    ["a", "b", "c", "d"].map((name, i) => ({
      name: `Take ${i + 1}`,
      src: `${name}.mp4`,
      sourceIn: i * 30,
      sourceFps: 30,
    })),
  );
  const take = withVersions
    ? ` data-cutroom-versions='${versions}' data-cutroom-version-index="0"`
    : "";
  const clips = Array.from({ length: 1000 }, (_, i) => {
    const start = (i * 2).toFixed(6);
    return `<video id="v${i}" src="a.mp4" data-start="${start}" data-duration="2" data-track-index="2" data-media-start="1" data-link="l${i}" data-has-audio${take}></video><audio id="s${i}" src="a.mp4" data-start="${start}" data-duration="2" data-track-index="1" data-media-start="1" data-link="l${i}"></audio>`;
  }).join("");
  const lengths = new Map(
    ["a", "b", "c", "d"].map((name) => [`${name}.mp4`, 60]),
  );
  return parseComposition(
    `<main data-composition-id="main" data-fps="30" data-duration="2000">${clips}</main>`,
    emptyTimelineSettings(),
    { mediaLengths: lengths, mediaFiles: new Set(lengths.keys()) },
  ).timeline;
}

/** Median time of a one-frame trim on a clip near the middle, as a drag sends on every move. */
function trimMs(withVersions: boolean) {
  let timeline = versionedTimeline(withVersions);
  const times: number[] = [];
  for (let i = 0; i < 15; i++) {
    const at = performance.now();
    const trim = CommandSchema.parse({
      type: "trim",
      clipId: "v500",
      edge: "end",
      to: 30060 - (i % 2),
    });
    timeline = applyAll(timeline, [trim]);
    times.push(performance.now() - at);
  }
  return times.sort((a, b) => a - b)[7]!;
}

test("a trim on a timeline of 1,000 versioned clips re-checks only the trimmed clip's takes", () => {
  const versioned = trimMs(true);
  const plain = trimMs(false);
  console.log(
    `trim median: ${versioned.toFixed(2)} ms with takes, ${plain.toFixed(2)} ms without`,
  );
  // Checking every take on every edit took about 50 ms here.
  expect(versioned).toBeLessThan(plain + 10);
});
