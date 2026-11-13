# Performance checks

Run the production UI benchmark with `bun run build && bun run bench:ui`. To compare a portable release, pass `--app /path/to/release/resources/app --output artifacts/baseline.json`. `CUTROOM_BENCH_PORT` selects an unused loopback port.

The benchmark creates synthetic local media and a project with 100 clips, 10,000 transcript words, and 200 chat messages. It uses three fresh browser contexts, consumes the rendered results, and checks that all 10,000 words can be selected. Native agent discovery is stubbed; inference speed is outside this measurement.

The November 9, 2026 local comparison used Bun 1.4.4, system Chromium, the portable 0.1.0 build, and the 0.1.2 production build. Each build ran separately. Version 0.1.2 uses the shared Agent/Review/Script panel; the benchmark opens the relevant tab before each operation. These are local measurements, not a comparison with proprietary HyperFrames Studio.

| Operation                                   |         0.1.0 |     0.1.2 |
| ------------------------------------------- | ------------: | --------: |
| Editor and conversation ready, median       |      1,050 ms |    824 ms |
| Initial project notebook response           | 747,317 bytes | 116 bytes |
| Saved note visible, median                  |        328 ms |    164 ms |
| 1,000 drawing events handled, median        |       55.7 ms |   17.6 ms |
| Drawing backing-store resizes               |         2,000 |         2 |
| Open 10,000-word script, median             |        487 ms |    206 ms |
| Select 10,000 words, median                 |        589 ms |    560 ms |
| Composer input to two animation frames, p95 |       31.2 ms |   31.3 ms |

The composer result does not show a reliable improvement. Browser-driver typing duration is not treated as input latency. Drawing is a synthetic burst intended to expose repeated canvas allocation, not a claim about physical pointer sampling rates.

The editor bundle contains one CodeMirror View instance instead of eight. The editor JavaScript fell from 6,176,227 to 5,110,853 bytes, and from 1,848,339 to 1,501,964 bytes with gzip. It retains the pinned upstream editor version and source-editing functionality.

`bun run bench:transcripts` measures transcript listing separately. Reusing one parsed source per request reduced the 100-clip, 5,000-word workload from about 154 ms to 7 ms warm. The request still reads current source files; this does not rely on a cross-request cache.

## Timeline engine

`bun run bench:timeline` measures the timeline engine on a transcript-cut composition: 240 linked picture and sound pieces plus 20 titles, 500 clips in 75 KB of HTML. It reports median milliseconds over 31 runs and exits with an error when a step exceeds its budget. The batch is a ripple delete near the start, a razor across every track, and a ripple trim, so most clips move. A second case lifts 1,000 of 2,000 clips in one batch, as select all and delete would; each removal first checks that the clip owns its bytes.

| Step                                        | Budget | November 10, 2026 |
| ------------------------------------------- | -----: | ----------------: |
| Parse HTML and settings into the projection |  10 ms |            3.5 ms |
| Apply the three-command batch               |   5 ms |            1.8 ms |
| Locate attributes and generate the edits    |   5 ms |            1.9 ms |
| `POST /commands` with history, median of 11 |  50 ms |           18.0 ms |
| Lift 1,000 of 2,000 clips: apply            |  20 ms |            1.1 ms |
| Lift 1,000 of 2,000 clips: generate edits   |  20 ms |            5.4 ms |

The request includes reading the source and settings, checking media files for lengths, two parses (before the edit and to verify the written result), and the history write. These figures were taken on a shared machine (load average about 4). Parsing builds the HTML spec tree with parse5. Generating edits scans the opening tags once to find attribute offsets. The ownership check visits only the clip's subtree and the owned bytes that can reach its range, found by binary search on a running maximum of their ends (text fostered out of a table can span later tags, so the ends alone are not sorted); scanning every node per removal took 121 ms for the 1,000-clip lift.

## New editor playback

Playback must hold the display rate with no React work per frame. On November 10, 2026, headless Chromium played a 12-second, 30 fps composition with two 1080p H.264 clips, a title, and music in the new editor at 1720x1050. The page counted animation-frame intervals, React commits through the devtools hook, and DOM changes outside the timecode.

| Mode        | Page frames | Frames over 25 ms | React commits | Other DOM changes |
| ----------- | ----------: | ----------------: | ------------: | ----------------: |
| Stopped, 3s |     60.3 /s |                 0 |             0 |                 0 |
| Play 1x, 4s |     60.3 /s |                 0 |             1 |                 3 |
| Shuttle 2x  |     60.3 /s |                 0 |             2 |                 4 |
| Shuttle 8x  |     60.0 /s |                 0 |             4 |                 6 |
| Reverse 2x  |     60.3 /s |                 0 |             2 |                 5 |

The commits and DOM changes are the transport buttons and shuttle readout changing state once per key press. The timecode is written directly, twice per composition frame.

## New editor timeline

The timeline must stay at the display rate with 500 clips. On November 10, 2026, Chromium 1720x1050 (headless, hardware GL) opened the timeline benchmark's composition in the new editor: 240 linked picture and sound pieces cut from one 720p H.264 file plus 20 titles, ten minutes at 30 fps. Each gesture was driven at one input event per frame under a Chromium trace. A late frame is an animation-frame interval over 20 ms. The machine was shared (load average 3 to 11), and three runs are summarised.

| Gesture                                          |     Page frames |    Late frames |  Worst frame | Main thread per frame |
| ------------------------------------------------ | --------------: | -------------: | -----------: | --------------------: |
| Ctrl+wheel zoom, fit to 32 px per frame and back | 59.1 to 59.4 /s | 9 to 11 of 910 |  33 to 67 ms |        9.3 to 11.7 ms |
| Zoom buttons, four in and four out, eased        |   58.4 to 60 /s |  0 to 3 of 185 |  17 to 67 ms |         3.9 to 4.3 ms |
| Scroll through time at 2 px per frame            |           60 /s |       0 of 920 |      16.8 ms |         0.9 to 1.3 ms |
| Marquee across three tracks                      |           60 /s |       0 of 265 |      16.8 ms |         1.3 to 1.6 ms |
| Play 1x, 5 s                                     |   58.8 to 60 /s |  0 to 2 of 340 |  17 to 83 ms |         3.6 to 5.1 ms |
| Shuttle 8x, 6 s, paging                          |     43 to 47 /s |       78 to 93 |        67 ms |           31 to 33 ms |
| Shuttle 8x with the timeline hidden              |           44 /s |             69 |        83 ms |                 33 ms |
| Scrub the ruler                                  |     47 to 59 /s |       9 to 133 | 33 to 117 ms |           19 to 26 ms |

At fit, all 500 clips are on screen as one element each. A zoom step writes `--ppf` and one scroll offset; the style pass for 500 clips is about 3 ms of the main-thread time above. The late zoom frames are the steps where React mounts or unmounts clips and labels as the view crosses a mounted range. Scrolling runs on the compositor: 40 clips are mounted at 2 px per frame and a render happens every half view.

### Clip bodies

Filmstrips and waveforms must not cost the timeline its frame rate. On November 10, 2026 the same 500-clip composition was opened over real media (a twelve-minute 720p H.264 file with sound, so 240 filmstrips and 240 waveforms) in Chromium 1720x1050, headless with hardware GL. Each gesture was driven one input event per animation frame. The first three columns are animation-frame intervals without tracing, two runs each; a late frame is an interval over 20 ms. Main thread per frame is thread time from a separate traced run, which also slows the page. Load average was 1 to 6.

| Gesture                                       |  p95 before | p95 after |                Late before |    Late after | Main thread per frame, before to after |
| --------------------------------------------- | ----------: | --------: | -------------------------: | ------------: | -------------------------------------: |
| Ctrl+wheel zoom, fit to 32 px per frame, back |     33.4 ms |   16.8 ms |            113, 117 of 910 |   1, 0 of 910 |                        16.3 to 10.8 ms |
| Ctrl+wheel zoom, fit to 2 px per frame        | 33 to 50 ms |   16.8 ms | 36 to 46 of 120, four runs | 0 to 2 of 120 |                        26.3 to 11.7 ms |
| Scroll time at 2 px per frame, 8 px a frame   |     16.8 ms |   16.8 ms |                0, 2 of 900 |   0, 0 of 900 |                          3.3 to 3.9 ms |
| Scroll time at 32 px per frame, 8 px a frame  |     16.8 ms |   16.8 ms |                2, 1 of 900 |   1, 0 of 900 |                          2.7 to 3.0 ms |
| Play 1x at fit, 5 s                           |     16.8 ms |   16.8 ms |                0, 0 of 300 |   0, 0 of 300 |                          3.1 to 2.5 ms |
| Play 1x at 2 px per frame, 5 s, paging        |     16.8 ms |   16.8 ms |                0, 0 of 300 |   1, 0 of 300 |                          3.0 to 2.9 ms |

Before is main without clip bodies. It missed frames while zooming near fit because every zoom step restyled every element under the grid: `--ppf` was inherited, so about 790 elements per step. With `--ppf` not inherited and clips placed in percent, a step restyles about 100. Drawing the bodies costs about 0.7 ms of script per zoom step, averaged over that sweep under a sampling profiler, and nothing while scrolling or playing: the canvas is drawn again only when the zoom changes, about every half view of scrolling, and when media arrives. React committed 0 or 1 times in five seconds of playback, and about once per five zoom steps, as before, when the view leaves its mounted range.

At 32 px per frame every filmstrip tile is its own frame from the server. Frames are asked for only after the view has rested 150 ms, and a move drops every request not yet sent, so scrolling there draws the sprite's frames and costs the same as at any other zoom.

### Audio clip finish

On November 10, 2026 the same 500-clip workload was checked at 1720x1050: 240 linked picture and sound pieces plus 20 titles, over a twelve-minute H.264/AAC file. Muted Chromium used ANGLE on an NVIDIA GeForce RTX 5060. Each run swept Ctrl+wheel zoom from fit to 32 px/frame and back for 910 animation frames, then scrolled at 2 px/frame by 8 px per frame for 900 frames. There were two runs per build. Before is `d315fb5`; after includes the audio clip finish. Gaps use `performance.now()` at callback entry and include all late frames. The machine was shared.

| Gesture |      FPS before | FPS after | Callback p95 after | Gaps over 20 ms after |
| ------- | --------------: | --------: | -----------------: | --------------------: |
| Zoom    |       56.8–58.2 | 59.5–59.7 |       18.7–18.8 ms |  32 of 909, both runs |
| Scroll  | 60.0, both runs | 59.5–60.0 |       17.1–17.8 ms |          15, 1 of 899 |

The averages stay near 60 fps, with occasional missed frames. Source peaks are remapped to the dB display scale once per fetched range, with no new animation loop. Gain overlays use the existing 28 px label threshold, since narrower clips cannot fit the trim margins and fade handles. Unautomated fades draw only endpoints and knees instead of 33 sampled vertices.

### Dragging

500 clips referencing a generated 15-second 320x180 H.264/AAC file, reused across the linked picture and sound pieces, fit view at 0.06776 px/frame, 415 clips following a ripple trim, Chromium 1720x1050. Hardware renderer verified as ANGLE on NVIDIA GeForce RTX 5060, OpenGL ES 3.2. Each run sent native pointer moves from an independent 60 Hz source for ten seconds, with the CPU profiler running. Callback gaps use `performance.now()` at actual callback entry, not RAF's supplied timestamp. These measurements were taken on the fix based on `3287a9d`, before the notes integration.

| Measurement                        |   00d1c00 | Rebased fix |
| ---------------------------------- | --------: | ----------: |
| Pointer moves handled              | 562 / 600 |   571 / 601 |
| Pointer updates handled per second |      56.2 |        57.0 |
| Pointer handler median             |   14.1 ms |      3.7 ms |
| Pointer handler p95                |   16.1 ms |      4.6 ms |
| Actual animation callback gap p95  |   30.0 ms |     27.4 ms |
| Input age at handler entry p95     |   16.8 ms |     17.1 ms |

The profile found a bounds read for the drag readout after hundreds of transform writes. Moving that read before the writes removes forced layout from the pointer handler. Synchronous input work falls, but sustained throughput stays around 56 to 57 updates per second, and animation callback p95 is still 27.4 ms. This does not establish 60 fps. Full-page rendering still needs work.

Pointer movement renders no React components and sends no edit request while the pointer is down. A pointer move that stays on the same frame and track writes only the readout's transform. One that reaches a new frame runs the shared engine for the preview, writes transforms to the mounted clips that move, and redraws the canvas. A clip whose length changed also gets the held length written into its duration label, with one custom property that carries the label to the held edge by transform. A roll writes two such labels, or four with linked sound. Bounds for the readout are measured before those writes.

Shuttle and scrubbing are slow on this composition because of the preview, not the timeline. With 480 media elements in the page the HyperFrames runtime does heavy work on every frame it is asked to show: main-thread script is about 30 ms per frame at 8x and 20 to 25 ms while scrubbing. The `seek()` call itself is the smaller part, about 4 to 5 ms at the median in review and about 14 ms while scrubbing; the rest is the runtime's own per-frame work. The timeline's script is 0.1 to 0.2 ms per frame in those rows, and hiding it changes nothing. At 1x the runtime plays its media itself, so playback holds the display rate.

### Zoom and ripple edits

The November 11, 2026 comparison used production builds on `81ba7b5`, before and after the timeline changes, Bun 1.4.4 and Chromium 155.0.8059.84 with SwiftShader, at 1720x1050 in dark mode. The workload has 190 or 240 linked picture/sound pairs and 20 titles. They reference a generated 60-second 640x360 H.264/AAC file, with actual filmstrips and waveform peaks loaded through the media service. Each project waits for the viewer's first confirmed paint and a 4.5-second warm-up.

There are three runs per build and size. Key zoom sends twelve inputs 100 ms apart and samples at least 300 ms after the last one. Wheel zoom sends sixteen inputs, one per displayed frame. Ripple delete removes the fourth linked pair in Fit, followed by undo, redo and restoration; Fit is measured after twelve zoom steps. Edit windows last one second. Frame gaps use `performance.now()` at animation callback entry. Long tasks come from `PerformanceObserver`.

All frame times are milliseconds. Long tasks are count/longest milliseconds, across the three runs. The machine was shared, so the maxima include scheduling noise.

#### 400 clips

| Interaction   | Before p50 |  p95 |   max | After p50 |  p95 |  max | Long tasks before → after |
| ------------- | ---------: | ---: | ----: | --------: | ---: | ---: | ------------------------- |
| Key zoom      |       18.5 | 50.7 | 121.0 |      16.7 | 23.7 | 66.9 | 7/119 → 4/66              |
| Wheel zoom    |       17.2 | 48.0 |  88.4 |      16.7 | 27.1 | 64.1 | 3/122 → 3/77              |
| Ripple delete |       16.8 | 77.0 | 171.4 |      16.7 | 44.6 | 78.2 | 3/161 → 3/76              |
| Undo          |       16.8 | 60.0 | 111.9 |      16.7 | 40.9 | 70.0 | 4/64 → 0/0                |
| Redo          |       16.8 | 49.1 | 113.1 |      16.7 | 47.0 | 80.4 | 3/70 → 0/0                |
| Fit           |       16.7 | 20.1 |  63.1 |      16.7 | 16.8 | 27.8 | 3/62 → 0/0                |

#### 500 clips

| Interaction   | Before p50 |  p95 |   max | After p50 |  p95 |   max | Long tasks before → after |
| ------------- | ---------: | ---: | ----: | --------: | ---: | ----: | ------------------------- |
| Key zoom      |       16.6 | 30.3 | 102.2 |      16.7 | 25.5 |  75.5 | 4/101 → 4/74              |
| Wheel zoom    |       16.7 | 29.0 |  67.8 |      16.7 | 27.9 |  65.1 | 3/86 → 3/88               |
| Ripple delete |       16.7 | 53.7 | 116.5 |      16.7 | 60.7 | 126.8 | 3/114 → 3/118             |
| Undo          |       16.7 | 45.0 | 101.9 |      16.7 | 46.0 |  75.8 | 0/0 → 0/0                 |
| Redo          |       16.7 | 49.6 | 136.8 |      16.7 | 57.3 |  69.6 | 1/82 → 0/0                |
| Fit           |       16.7 | 17.0 |  43.9 |      16.7 | 16.8 |  34.7 | 0/0 → 0/0                 |

The 400-clip maximum key-zoom frame fell from 121.0 to 66.9 ms, and ripple from 171.4 to 78.2 ms. At 500 clips, ripple p95 rose from 53.7 to 60.7 ms and maximum from 116.5 to 126.8 ms. Fit now has a separate finite rescale after the gap closes. (Since November 12, 2026 an edit no longer changes the scale at all, so a fitted ripple is only the gap closing and that rescale is gone.) These measurements do not establish a steady 60 fps during edits.

Tracing found synchronous style/layout under viewport geometry reads and repeated whole-lane selector scans in edit motion. The viewport now reads size and offsets on resize/scroll, reads animation tokens before writes, and skips an unchanged scroll write. Motion finds moved clip nodes in one pass. Clip bodies were already memoized, canvas drawing was a smaller part of these stalls, and the 500-clip engine batch still applies in about 2 ms; neither the canvas representation nor engine normalization changed.

`CUTROOM_PERF_DIR=artifacts/timeline-performance bun run bench:timeline-ui` reproduces the three-run production workload. `bun run test:perf` also runs three passes per size. For key zoom and ripple separately, it requires the median of the three per-run maximum frame gaps to stay below 150 ms. One isolated pause passes; a stall at or above 150 ms in two of three runs fails. Pooled p95 can hide a single bad frame that recurs on every edit, so the budget uses per-run maxima. The original 400-clip before-build ripple maxima were 171.4, 140.7 and 163.7 ms, giving a failing median of 163.7 ms; the after-build median was 68.2 ms. Both 500-clip medians passed.

The previous single-maximum gate failed export PR #61. In CI run `42989564025`, the 400/500-clip ripple maxima were 174.1/168.1 ms, with one long task of 159/164 ms and second-worst frames of 118.4/81.3 ms. The worst gap was the first frame after Delete, as in the other inspected failures. These are real first-edit stalls; the samples alone do not establish whether code or runner speed caused them. Repetition keeps the ceiling while allowing one slow interaction run. It can miss a regression confined to the first edit, and it does not excuse sustained CPU starvation or promise 60 fps. CI runs the budget in its own job, on a fresh runner beside three browser-suite shards and a separate format, type, and unit-check job. Browser shards split at test boundaries with one worker each; the list reporter records per-test durations in CI logs. The 150-edit document and decoded-frame resource budgets run in the performance job alongside the frame-time budgets, so those long workloads do not accumulate in the last browser shard.

`CUTROOM_PERF_RUNS` overrides the positive integer run count. The default is three; larger values use the upper median of per-run maxima, and setting it to one restores the stricter single-maximum check for a short diagnostic run. The `frame-times.json` attachment and `CUTROOM_PERF_DIR` output retain every frame and long task, pooled p50/p95/max, and the new `medianMax` statistic. Key/ripple summaries also appear in passing CI logs, since failure-only artifacts cannot supply a passing baseline. Set `CUTROOM_PERF_TRACE=1` for compressed Chromium traces. Profiled runs retain timings and check behavior; budgets run without the profiler's overhead.

The exact parent of #59 is `006fa27`, not the historical `81ba7b5` before-build above. A later check compared production builds of `e5c593f` and `006fa27`, with three independent sessions per build and condition, three interaction runs per size in each session, Bun 1.4.4 and installed Chromium 155 with SwiftShader at 1720x1050. Without injected load on the shared host, main passed all three sessions; the parent passed two and failed one. Its 500-clip ripple median was as low as 101.4 ms, while main reached 116.8 ms. With both builds pinned to four logical CPUs and two busy workers on the same CPUs, both failed all three sessions. These distributions do not support a gate that reliably rejects that exact parent while accepting main. The budget preserves the signal in the original #59 samples, rather than claiming to detect every reversion of that patch.

On the same host, main passed the old one-run gate both before and after all 158 functional browser tests left 168 projects in the data directory. Ripple maxima were 75.5/90.4 ms on fresh data and 70.9/87.5 ms afterward, at 400/500 clips. Both checks took about 42 seconds. Three passes took 93–103 seconds, excluding the unchanged production build. The CI job limit is 20 minutes so this added minute fits after the functional suite; the existing #62 job had already taken 14m53s against the old 15-minute limit.

[An unchanged-main branch control](https://github.com/AksharP5/cutroom/actions/runs/42999124119) passed the old gate, so branch identity alone did not reproduce the failures. A [paired CI comparison](https://github.com/AksharP5/cutroom/actions/runs/43002141979) then built exact main `e5c593f` and export head `0eebac9` on one runner with Chromium 158. Both passed normally: median ripple maxima were 85.8/84.8 ms for main and 83.4/93.3 ms for the export build, at 400/500 clips. With identical 2× browser CPU throttling, both failed: main reached 159.0/206.7 ms and export reached 168.7/191.0 ms. Separate profiled passes showed comparable style/layout work over the same element counts; their timings include profiler overhead. This did not reproduce an export-specific ripple regression. It confirms that the absolute ceiling can fail the shared baseline when execution slows; repetition only protects against one slow run, not a consistently slow environment.

[Raw timings, matching worst-frame trace excerpts and compressed traces](https://github.com/AksharP5/cutroom/tree/pr-assets/timeline-frame-rate) include browser, renderer and viewport metadata. The separate profiled 400-clip pass had a worst frame of 104.7 ms before and 84.8 ms after. Those screenshots plot the actual Chromium events and source-map locations; the tables use untraced runs.

### First ripple after loading

On November 11, 2026, production builds of `6e6094c` and the first-ripple fix ran on the same host, Bun 1.4.4, installed Chromium 155.0.8059.84 with SwiftShader, at 1720x1050. Each build had three fresh browser/backend sessions, with three interaction runs per size in each session. The table shows the median of the three session medians of per-run maximum frame gaps, in milliseconds.

| Gesture | 400 clips, before / after | 500 clips, before / after |
| ------- | ------------------------: | ------------------------: |
| key     |               62.1 / 64.4 |               57.4 / 61.8 |
| wheel   |               46.2 / 48.3 |               58.1 / 55.1 |
| ripple  |               67.2 / 59.1 |               87.2 / 62.4 |
| undo    |               55.4 / 50.1 |               67.7 / 54.9 |
| redo    |               58.1 / 56.6 |               72.1 / 55.1 |
| fit     |               26.5 / 22.2 |               32.1 / 29.7 |

The 500-clip ripple median fell from 87.2 to 62.4 ms. The three after-session ripple medians were 60.1/49.1/59.1 ms at 400 clips and 62.4/50.7/77.4 ms at 500. First-ripple maxima were 57.4/43.7/77.2 and 62.6/67.3/77.4 ms respectively. The key-zoom results do not show a speedup. The 150 ms budget and the workload are unchanged.

Separate one-run traces found the first 400/500-clip ripple frame fell from 82.2/97.3 to 50.0/60.3 ms. Its largest style pass still covered 782/982 elements, since this edit moves almost every clip, but fell from 31.0/35.3 to 9.2/13.2 ms. Layout in that frame fell from 14.6/17.3 to 10.9/14.0 ms. The worst remaining ripple gaps were later, at 317/402 ms after input: 61.0/65.8 ms, with a largest style pass of 2/41 elements taking 0.126/0.265 ms and total layout of 0.803/0 ms. Traced frame times include profiling overhead.

Clip positions now divide by a fixed coordinate span, while only the grid uses the changing project length. Layout containment keeps that coordinate box out of the scroll extent. Edit motion writes moved clips' translations in one finite animation-frame callback instead of starting a Web Animation per element. It calculates easing once per edit, adds overlapping slides, and uses the document animation clock shared with Fit. The recording indicator keeps its own project-length width.

Paired 500-clip screenshots freeze both animation clocks at 110 ms, then capture the settled Fit. The sampled clip bounds match exactly at both points. The mean RGB channel difference is 0.109/255 mid-slide and 0.021/255 after Fit, with small rasterization differences visible in the raw comparison. Existing browser checks also cover interrupted Fit, overlapping undo, held trims, and recording against the playhead.

[Every session's median maximum and p95, raw frame samples, traces, capture method, and matching images](https://github.com/AksharP5/cutroom/tree/pr-assets/ripple-first-edit) are retained separately from the source branch. Reproduce with `CUTROOM_PERF_DIR=... bun run test:perf`; set `CUTROOM_PERF_TRACE=1 CUTROOM_PERF_RUNS=1` for the separate profiling pass.

## Trim preview

The 400-clip roll check sends 540 pointer updates over 180 displayed frames per run, with all clips mounted at Fit. Each run must send more than ten seeks, send no more seeks than displayed frames, and keep at most one seek in flight. These assertions gate seek coalescing independently of runner speed.

Frame pacing uses three fresh page loads and the median of their per-run p95 callback gaps, with a 75 ms ceiling. The clock is `performance.now()` at callback entry, so delays before a callback runs remain visible. This roll-specific check complements the zoom and ripple-delete budgets above. One slow run can pass; p95 at or above 75 ms in two of three runs fails. `CUTROOM_PERF_RUNS` also controls this run count. Logs, the `trim-frame-times.json` attachment, and `CUTROOM_TRIM_PERF_DIR/400-trim.json` retain the individual runs.

On November 11, 2026, the rebased trim build ran in installed Chromium 155 at 1720x1050. The contention case pinned the browser, server, and two busy workers to the same four logical CPUs. These are local scheduling measurements, not a reproduction of Chromium 158 on GitHub's runner.

| Condition                   | Per-run p95 callback gaps | Median p95 | Seeks per run | Maximum pending |
| --------------------------- | ------------------------- | ---------- | ------------- | --------------- |
| Shared host                 | 27.1, 26.0, 22.3 ms       | 26.0 ms    | 60, 59, 56    | 1               |
| Four CPUs, two busy workers | 50.9, 58.7, 51.9 ms       | 51.9 ms    | 53, 54, 55    | 1               |

The previous single-run ceiling of less than 50 ms would reject all three contention measurements despite bounded seeks. [CI job `130688607437`](https://github.com/AksharP5/cutroom/actions/runs/43068171313/job/130688607437) likewise reported exactly 50 ms with 51 seeks and one pending request. The 75 ms ceiling leaves 23.1 ms above the measured contention median while retaining a repeated pacing gate. It does not promise 60 fps or tolerate consistently slower execution without limit.

A temporary negative control removed the seek queue's in-flight guard. The roll reached three pending seeks and failed the one-pending assertion, even with p95 at 34.2 ms. The guard was restored before final validation. Frame pacing alone cannot detect that backlog; the functional seek assertions remain the gate on every run.

The frame-accuracy fixture encodes source frame numbers in binary `drawbox` squares. It needs neither `drawtext` nor a system font; CI's static FFmpeg 6.1.1 reports `No such filter: 'drawtext'`. Local FFmpeg 9.0.2 marks `drawbox` with timeline support, and the browser cases generate and decode the fixture without text.

## Position preview

The preview observes only the selected clip with a non-zero Position, after seek/pause and at most three times per second during playback. Seek observations coalesce to one per animation frame after the latest picture settles. A paused video is observed through its displayed canvas, since the bridge hides its native surface. The observer reads styles without inserting a DOM probe. With nothing selected it does not inspect clip styles or run an observation timer. Position commits do not compile or render a test document.

A 500-clip real-media project, including a selected title with Position X = 40 px, played for 2.5 seconds per run. Three runs per condition compared production builds of `71bccbb` and this change in installed Chromium 155 at 1720×1050. Values below are medians of each run's frame-gap percentiles, in milliseconds.

| Selection        | Before p50 | After p50 | Before p95 | After p95 |
| ---------------- | ---------: | --------: | ---------: | --------: |
| None             |       16.7 |      16.7 |       16.7 |      16.7 |
| Positioned title |       16.7 |      16.7 |       16.8 |      16.8 |

No playback timing increase was measured in these runs. The unselected condition emitted zero observations in every run; the selected title was checked at the capped rate. These supplied-rAF-timestamp percentiles hid alternating 30 ms observer stalls in review, so they are no longer the gate. [Paired measurements](https://github.com/AksharP5/cutroom/blob/pr-assets/inspector-position/position-playback.json) retain the build, browser and observation counts. This checks the observed playback cost on this host, rather than promising a universal zero-cost guarantee.

A GSAP x/y slide-in title with Position 40 px right and 10 px up retained its offset during playback and repeated seeks. FFmpeg-decoded MP4 frames 3, 15 and 45 matched the preview's video and title bounds within one pixel. [Decoded positions](https://github.com/AksharP5/cutroom/blob/pr-assets/inspector-position/position.json) retain the baseline, preview and export bounds. A separate hands-on drag/play/export check matched all four title edges exactly at frames 0, 30 and 90.

The performance test now collects `cutroom:position-observation` measures from the isolated preview and requires the median of three per-run maximum observation durations to stay below 5 ms. Nothing selected must produce zero measures. Three runs per condition also count callback-entry gaps above 1.5 times the measured display interval during playback and ruler scrubbing, with and without the Position-edited title. The selected condition's median late-frame rate may rise by less than five percentage points. The direct observer budget catches repeated costly checks that a frame percentile can hide. Like #63, it tolerates one isolated slow run and retains every outlier. `position-observation.json` records each duration and callback gap, and `CUTROOM_POSITION_TIMING_OUT` saves that attachment locally.

On November 11, 2026, installed Chromium 155 on the same 500-clip workload measured a maximum observer duration of 0.9 ms in both playback and scrubbing. All six unselected runs produced zero observations. Playback had two late callbacks in each run, with either selection; scrubbing had 2/4/2 without selection and 1/2/2 with the positioned title. A temporary local change stalled alternate observations for 30 ms. The new per-observation gate failed at 30.4 ms; the injected change was removed. These local results establish that the gate catches that regression, not that every host has the same timings.

### Track heights

On November 11, 2026 the production build resized the top title track from 56 to 146 px and back on the same 400-clip real-media workload, at Fit, 1720x1050 and DPR 1. Bun 1.4.4 drove system Chromium 155.0.8059.84 with SwiftShader, muted. The pointer source requested 180 native moves at 60 Hz. Frames use callback-entry `performance.now()`, and a late interval exceeds 20 ms. The machine was shared.

| Height drag                    | Frame p50 |     p95 |   Worst | Late intervals | Long tasks | Individual clip style writes | Canvas reallocations |
| ------------------------------ | --------: | ------: | ------: | -------------: | ---------: | ---------------------------: | -------------------: |
| Without tracing, separate pass |   16.7 ms | 16.8 ms | 16.9 ms |        0 / 179 |          0 |                            0 |     Not instrumented |
| With a Chromium timeline trace |   18.3 ms | 20.4 ms | 23.3 ms |       25 / 226 |          0 |                            0 |                    0 |

The untraced pass delivered all 180 moves in 3.002 seconds. In the traced run, each of 180 style passes touched 35 elements, rather than the 400 clips. Total style work was 69.7 ms, about 0.39 ms per pass. Pointer moves update the row containers and redraw the shared media canvas once per animation frame. Exact filmstrip requests wait until resizing rests. Browser tests check actual filmstrip and waveform pixels at DPR 1 and 2, including Compact and manually enlarged filmstrips.

The same `bun run test:perf` invocation passed all five performance tests, including the existing three-run 400/500-clip zoom and ripple budgets. Frame times across the three runs were:

| Clips | Key zoom p95 |   Worst | Ripple delete p95 |   Worst |
| ----: | -----------: | ------: | ----------------: | ------: |
|   400 |      23.0 ms | 71.8 ms |           32.5 ms | 60.9 ms |
|   500 |      20.5 ms | 72.7 ms |           42.4 ms | 64.9 ms |

The screenshot and raw timing evidence is on the `pr-assets` branch under `track-heights/`.

## Selection on the picture

The bridge caches the selected clip's element and last posted box. Seek, pause, paint, Position edits, resize and changes to that clip or its ancestors invalidate the box. Reads coalesce into one animation-frame callback, after the draft's style writes. Unchanged attribute assignments do not invalidate it. GSAP and script motion invalidate through DOM mutations; CSS animations on the clip, its children or ancestors keep frame tracking only while running. Nothing is read with no clip selected. The editor places the outline with transforms outside React.

A press costs one `elementsFromPoint` in the preview and style reads for elements under the pointer. A pointer moving over a stopped picture costs the same, with one request in flight at a time, and a press at the point being asked takes that answer; a playing picture is never asked. Only a hit test temporarily enables pointer events on visible elements whose computed value is `none`. It restores the exact inline values in `finally`. Captures never request hits. Selection immediately reuses the hit's box, before React renders the inspector.

`bun run test:perf` collects `cutroom:clip-box` and `cutroom:position-observation` separately on the 500-clip real-media workload. Each budget remains below 5 ms, applied to the median of three fresh runs' maximum durations. This follows #63's smallest odd sample that tolerates one isolated pause while failing a repeated stall. Raw durations, overall maxima and per-run maxima remain in `position-observation.json`; `CUTROOM_POSITION_TIMING_OUT` saves it locally. Static selected playback may make at most six geometry reads per 2.5-second run. Unselected runs must make none, and selection may not add five percentage points to the median late-frame rate.

The picture-paint gate measures native pointer-down `timeStamp` to a task after the outline update's next animation frame, including that rendering opportunity. It makes ten alternating video/title clicks in each of three fresh loads, after drawn clip bodies and a 4.5-second media warm-up. Cold clicks stay in each run's maximum. The median maximum must be at most 50 ms, three frames at 60 Hz and well below the roughly 100 ms instant-response threshold. CI Chromium 158 with SwiftShader measured 35.2 ms against the previous 33 ms ceiling. That two-frame ceiling was too close to normal runner variation. The measurement method is unchanged. `picture-selection-paint.json` and `CUTROOM_PICTURE_TIMING_OUT` retain every pointer, outline and after-paint timestamp, cold click and bridge hit cost. This includes a rendering opportunity, not physical display scan-out.

Negative controls run inside actual preview reads without changing production code:

- `CUTROOM_POSITION_READ_STALL_MS=10` stalls the selected title's geometry read.
- `CUTROOM_POSITION_OBSERVATION_STALL_MS=10` stalls the selected title's computed-style read.
- `CUTROOM_PICTURE_HIT_STALL_MS=60` stalls `elementsFromPoint`. This replaces the old 40 ms control so it clearly exceeds the 50 ms paint budget.

Run either gate with `bun run test:perf --grep 'Position observation'` or `bun run test:perf --grep 'picture selection paints'`.

The round-three comparison uses installed Chromium 155.0.8059.84, SwiftShader and a 1720×1050 viewport. No software or browsers were downloaded. The before control restores the bridge and observation test from `a44fdb7` on the same rebased UI, keeping #79's timeline title labels in both conditions. Each uses the same 500-clip project shape, three fresh runs per selected/unselected playback/scrub condition.

| Selected condition | Before geometry reads | After geometry reads | Before Position / outline | After Position / outline |
| ------------------ | --------------------: | -------------------: | ------------------------: | -----------------------: |
| Playback           |         162, 162, 163 |              3, 3, 3 |              0.2 / 1.2 ms |             0.6 / 1.0 ms |
| Scrub              |            95, 95, 95 |           92, 92, 92 |              0.2 / 1.1 ms |             0.4 / 0.9 ms |

Each cost is the median of three per-run maxima. Reads are per fresh load; playback lasts 2.5 seconds. The before control restores the `a44fdb7` bridge and observation test on the same rebased UI. Both conditions share CPUs 0–7 with two busy workers. No unselected run makes a Position or outline read.

| Full performance session | Position playback / scrub | Outline playback / scrub |        Paint maxima | Median paint | Result     |
| ------------------------ | ------------------------: | -----------------------: | ------------------: | -----------: | ---------- |
| 1                        |              0.6 / 0.4 ms |             1.0 / 0.9 ms | 29.5, 30.7, 29.3 ms |      29.5 ms | All 6 pass |
| 2                        |              0.5 / 0.4 ms |             0.9 / 0.9 ms | 25.8, 27.2, 25.4 ms |      25.8 ms | All 6 pass |
| 3                        |              0.4 / 0.4 ms |             1.1 / 0.9 ms | 30.1, 27.6, 37.0 ms |      30.1 ms | All 6 pass |

| Injected stall, same CPU condition |      Per-run maxima | Median maximum |    Gate | Result |
| ---------------------------------- | ------------------: | -------------: | ------: | ------ |
| 10 ms geometry read                | 11.7, 11.3, 10.9 ms |        11.3 ms |  < 5 ms | Fail   |
| 10 ms Position style read          | 10.3, 10.4, 10.8 ms |        10.4 ms |  < 5 ms | Fail   |
| 60 ms picture hit                  | 86.5, 88.8, 87.1 ms |        87.1 ms | ≤ 50 ms | Fail   |
