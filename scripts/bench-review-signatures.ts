import { sourceClipVersions } from "../src/server/projects/changes";

// Keep the same 500-clip input across signature implementations.
const count = 500;
const clips = Array.from(
  { length: count },
  (_, i) =>
    `<div id="clip-${i}" class="clip group-${i % 10}" data-start="${i}" data-duration="1" data-track-index="0">Clip ${i}</div>`,
).join("\n");
const styles = Array.from(
  { length: count },
  (_, i) => `#clip-${i} { color: rgb(${i % 255}, 100, 120); }`,
).join("\n");
const tweens = Array.from(
  { length: count },
  (_, i) => `tl.to("#clip-${i}", {opacity: 1, duration: .5}, ${i});`,
).join("\n");
const source = (revision: number) =>
  `<html><head><style>${styles}</style></head><body><main data-composition-id="main" data-duration="${count}">${clips}</main><script>const tl = gsap.timeline({paused:true});\n${tweens}\ntl.set("#clip-0", {x:${revision}}, 0);</script></body></html>`;
const measure = (run: (i: number) => void) => {
  const times = Array.from({ length: 60 }, (_, i) => {
    const start = performance.now();
    run(i);
    return performance.now() - start;
  })
    .slice(10)
    .sort((a, b) => a - b);
  return {
    p50Ms: +times[Math.floor(times.length * 0.5)]!.toFixed(3),
    p95Ms: +times[Math.floor(times.length * 0.95)]!.toFixed(3),
  };
};
console.log(
  JSON.stringify(
    {
      clips: count,
      bytes: source(0).length,
      revision: measure((i) => {
        sourceClipVersions(source(i), "index.html");
      }),
      unchanged: measure(() => {
        sourceClipVersions(source(59), "index.html");
      }),
    },
    null,
    2,
  ),
);
