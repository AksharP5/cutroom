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
| Ctrl+wheel zoom, fit to 32 px per frame, back |     33.4 ms |   16.8 ms |            113, 117 of 910 |   2, 1 of 910 |                        16.3 to 10.5 ms |
| Ctrl+wheel zoom, fit to 2 px per frame        | 33 to 50 ms |   16.8 ms | 36 to 46 of 120, four runs | 1 to 2 of 120 |                        26.3 to 13.1 ms |
| Scroll time at 2 px per frame, 8 px a frame   |     16.8 ms |   16.8 ms |                0, 2 of 900 |   0, 0 of 900 |                          3.3 to 3.6 ms |
| Scroll time at 32 px per frame, 8 px a frame  |     16.8 ms |   16.8 ms |                2, 1 of 900 |   0, 0 of 900 |                          2.7 to 2.9 ms |
| Play 1x at fit, 5 s                           |     16.8 ms |   16.8 ms |                0, 0 of 300 |   0, 0 of 300 |                          3.1 to 3.3 ms |
| Play 1x at 2 px per frame, 5 s, paging        |     16.8 ms |   16.8 ms |                0, 0 of 300 |   0, 1 of 300 |                          3.0 to 3.3 ms |

Before is main without clip bodies. It missed frames while zooming near fit because every zoom step restyled every element under the grid: `--ppf` was inherited, so about 790 elements per step. With `--ppf` not inherited and clips placed in percent, a step restyles about 100. Drawing the bodies costs about 0.7 ms of script per zoom step, averaged over that sweep under a sampling profiler, and nothing while scrolling or playing: the canvas is drawn again only when the zoom changes, about every half view of scrolling, and when media arrives. React committed 0 or 1 times in five seconds of playback, and about once per five zoom steps, as before, when the view leaves its mounted range.

At 32 px per frame every filmstrip tile is its own frame from the server. Frames are asked for only after the view has rested 150 ms, so scrolling there draws the sprite's frames and costs the same as at any other zoom.

Shuttle and scrubbing are slow on this composition because of the preview, not the timeline. With 480 media elements in the page the HyperFrames runtime does heavy work on every frame it is asked to show: main-thread script is about 30 ms per frame at 8x and 20 to 25 ms while scrubbing. The `seek()` call itself is the smaller part, about 4 to 5 ms at the median in review and about 14 ms while scrubbing; the rest is the runtime's own per-frame work. The timeline's script is 0.1 to 0.2 ms per frame in those rows, and hiding it changes nothing. At 1x the runtime plays its media itself, so playback holds the display rate.
