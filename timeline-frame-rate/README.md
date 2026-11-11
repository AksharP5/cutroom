# Timeline zoom and ripple evidence

Three untraced production runs per build at 400 and 500 clips, November 11, 2026. Both builds use main `81ba7b55dd85580068b702c4678398703d340291`. The after build applies the timeline changes now in `7d78205297dba48c71728276c3a52836faded256`, subsequently rebased onto the viewer handoff fix `df914b8`.

The JSON files contain every frame sample and long task, pooled summaries, browser version, renderer and viewport. The synthetic workload uses 190 or 240 linked video/audio pairs and 20 titles. All media references a generated 60-second 640x360 H.264/AAC source with real filmstrip and waveform service results. Chromium uses SwiftShader at 1720x1050, dark mode, no CPU throttling. The host was shared.

Key zoom sends twelve inputs 100 ms apart. Wheel sends sixteen inputs, one per animation frame. Ripple removes the fourth linked pair in Fit, followed by undo, redo, restoration and Fit from twelve zoom steps. Edit measurement windows last one second. All gaps use performance.now() at callback entry. Long tasks use PerformanceObserver. Each project waits for the viewer's live iframe, canvas content and a 4.5-second warm-up.

`before-worst.png` and `after-worst.png` plot actual events from the separate single-run Chromium profiles, clipped to each run's worst measured 400-clip frame gap. These are trace excerpts with production source-map locations, rather than DevTools screenshots. Their 104.7 ms and 84.8 ms gaps differ from the untraced three-run maxima. Nested event durations overlap. Open the compressed traces in Chromium Performance or Perfetto for the full events and CPU samples.

The initial engine benchmark and the after engine benchmark both pass the existing 500-clip budgets. Engine code is unchanged. The initial run predates the later viewer/voiceover integrations; it is retained as initial measurement evidence, not a same-base speedup claim.

The 400-clip key maximum falls from 121.0 to 66.9 ms and ripple from 171.4 to 78.2 ms. At 500 clips ripple maximum rises from 116.5 to 126.8 ms. These results do not establish steady 60 fps during edits. A longer functional run also produced 169 ms ripple and 181 ms key outliers; a fresh backend against the same files passed. CI therefore runs the strict 150 ms key/ripple ceilings in its own backend after the functional suite. Long-session outliers remain a limitation.

Reproduce from the PR branch:

```sh
CUTROOM_PERF_DIR=artifacts/timeline-performance bun run bench:timeline-ui
CUTROOM_PERF_TRACE=1 CUTROOM_PERF_DIR=artifacts/timeline-traces bun run test:perf
bun run bench:timeline
```

Tracing records timing and checks behavior; the untraced workload enforces the frame budgets.
