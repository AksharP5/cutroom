import { expect, mock, test } from "bun:test";
import * as lightningcss from "lightningcss";

// Counts inline style parses: each one is a native call, and plans read every clip's style.
let parses = 0;
const { transformStyleAttribute } = lightningcss;
mock.module("lightningcss", () => ({
  ...lightningcss,
  transformStyleAttribute: (
    ...args: Parameters<typeof transformStyleAttribute>
  ) => {
    parses++;
    return transformStyleAttribute(...args);
  },
}));
const { planPreviewPipeline } =
  await import("../src/server/hyperframes/pipelinePlan");

test("planning GPU playback parses each distinct clip style once, not once per clip", () => {
  const fill = "position:absolute;inset:0;width:100%;height:100%";
  const videos = Array.from(
    { length: 300 },
    (_, index) =>
      `<video id="shot-${index}" src="talk.mp4" muted data-start="${index}" data-duration="1" data-media-start="${index}" data-track-index="0" style="${fill}${index % 2 ? ";object-fit:cover" : ""}"></video>`,
  ).join("\n");
  const html = `<!doctype html><html><head></head><body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="300" data-fps="30">
${videos}
</main></body></html>`;
  parses = 0;
  const plan = planPreviewPipeline(html, { num: 30, den: 1 });
  expect("drawable" in plan && Object.keys(plan.drawable)).toHaveLength(300);
  expect(parses).toBeLessThan(10);
});
