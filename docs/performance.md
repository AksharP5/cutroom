# Performance checks

Run the production UI benchmark with `bun run build && bun run bench:ui`. To compare a portable release, pass `--app /path/to/release/resources/app --output artifacts/baseline.json`. `CUTROOM_BENCH_PORT` selects an unused loopback port.

The benchmark creates synthetic local media and a project with 100 clips, 10,000 transcript words, and 200 chat messages. It uses three fresh browser contexts, consumes the rendered results, and checks that all 10,000 words can be selected. Native agent discovery is stubbed; inference speed is outside this measurement.

The November 9, 2026 local comparison used Bun 1.4.4, system Chromium, the portable 0.1.0 build, and the 0.1.2 production build. Each build ran separately. Version 0.1.2 uses the shared Agent/Review/Script panel; the benchmark opens the relevant tab before each operation. These are local measurements; see [Cutroom vs HyperFrames Studio](#cutroom-vs-hyperframes-studio) for a comparison with Studio.

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

The new editor's code panel loads CodeMirror only when it first opens: its editor chunk (4.7 KB) and the CodeMirror chunk it shares with the embedded editor (511 KB, 177 KB with gzip) are not preloaded with the editor. On November 16, 2026 the panel added 0.2 KB to the app's entry script and 9 KB (3 KB with gzip) to the editor's own chunk, and the embedded editor's chunk shrank by the CodeMirror it now shares. Opening a project to a ready preview took a median 838 ms with the panel against 840 ms without (20 headed runs each, alternating builds). The first open of the panel showed the source in about 390 ms, and selecting a clip showed its element in about 110 ms.

`bun run bench:transcripts` measures transcript listing separately. Reusing one parsed source per request reduced the 100-clip, 5,000-word workload from about 154 ms to 7 ms warm. The request still reads current source files; this does not rely on a cross-request cache.

## Cutroom vs HyperFrames Studio

On November 16, 2026 the same project was opened and edited in Cutroom (main `c3db508`, default settings, so the footage pipeline was off) and in HyperFrames Studio 0.9.26, run from this repository's `node_modules` with `hyperframes preview --no-open`. `node scripts/bench-vs-studio.ts` does both: it makes the project, starts the editor's own server on a private port, and drives one headed Chromium 155 window (X11, 1720x1050, muted) through every operation below. Three runs per editor, each with a fresh server, project copy and browser, unthrottled and with CPU throttled 4x (the editor page and, in Cutroom, its out-of-process preview). The machine was shared: load average about 10 to 13 from other work during the runs. The play rows were measured again the same day on main `4f506ed`, three runs per column, measured as described under 1x playback below.

The project is a five-minute 1080p30 edit with 123 clips: 100 three-second cuts from one two-minute 8 Mbit/s H.264 source with a one-second GOP, a music bed, 20 text titles, and a GSAP sub-composition placed twice. Every source frame carries its number in sixteen blocks along the top. A CDP screencast records every composited frame of the tab and each picture is read back by that number, so "to picture" means the viewer showed the expected source frame. Edits run on shots 22, 23, 24, 27 and 28, which nothing else overlaps; a ripple delete must show the next shot's frame at the same playhead, and undo the original frame again.

### Where Cutroom loses

1. **Opening to the first picture.** 687 ms against Studio's 520 ms when reopening (median of six), 1,058 ms against 712 ms on the first open after the server starts (median of three). The editor asks for its preview about 470 ms after navigation, together with its first timeline read, so the preview cannot start loading until the editor has loaded and mounted (`src/client/edit/Viewer.tsx:391`), and the first compile of the preview document took 352 ms on the server (28 ms warm, against 2 to 5 ms for Studio's). The viewer then checks the runtime's readiness every 50 ms (`src/client/edit/Viewer.tsx:609-614`). Cutroom shows the whole timeline 440 ms sooner than Studio (902 ms against 1,345 ms), so it is the picture that comes late, not the editor.
2. **Ripple delete to picture is no faster than Studio's.** 603 ms against 632 ms unthrottled, although Cutroom's timeline shows the edit in 18 ms. Any authored `<script>` makes a composition ineligible for in-place preview updates (`src/server/hyperframes/previewTimingPolicy.ts:61-65`), and HyperFrames projects register their timelines in one (Studio's linter reports a composition without `window.__timelines` as an error), so every edit here loads a new preview document. The viewer's `data-preview-timing-ready` stayed unset and the live frame's document changed on the edit. Throttled 4x, Cutroom is four times faster than Studio here (691 ms against 2,761 ms).

**1x playback is even in both.** An earlier version of this comparison counted 55 late pictures per ten seconds in Cutroom against 4 in Studio. It timed each picture by a `requestVideoFrameCallback` in the preview, and that callback runs on the preview's main thread at the first animation frame after the compositor has put the picture up, so it can land a display frame early or late while the picture itself does not. A Chrome trace of the same ten seconds showed the preview's video compositor putting up a new picture every second display frame 308 times of 315 in both editors, with the same three longer holds; only the callbacks wandered, 47 times in Cutroom's out-of-process preview and 9 in Studio's. The main threads were not short of time either: during play Cutroom's preview process ran 106 ms of main-thread work a second and its editor 166 ms, against 338 ms for Studio's single process. The play rows below now read the frame number from every composited frame of the tab, as the drags do. The longest holds in both editors are at cuts and at the keyframe one second into shot 23 (frame 990), where both hold a picture about 100 ms. At the cut from shot 22 to 23 Cutroom holds the old shot's last picture 120 to 133 ms and then plays the new shot from its first frame, where Studio holds twice for 66 and 86 ms and skips a frame of each shot. What causes these holds was not measured here.

### Results

Median / p95 pooled over three runs; a single value is the median of the three runs. Edit rows have 15 samples each, drags 9, opens 6 (or 3 for the first open). Opening ran before throttling, so it has no 4x column.

| Operation                                    |     Cutroom 1x |        Studio 1x |   Cutroom 4x |        Studio 4x |
| -------------------------------------------- | -------------: | ---------------: | -----------: | ---------------: |
| First open to frame 0 shown, per run         | 1,049-1,079 ms |       691-713 ms |            - |                - |
| Reopen to frame 0 shown                      |   687 / 701 ms |     520 / 533 ms |            - |                - |
| Reopen to all 100 shots on the timeline      |   902 / 904 ms | 1,345 / 1,358 ms |            - |                - |
| Ruler drag, 3 s: new pictures per second     |        14 / 19 |        4.6 / 6.0 |    3.6 / 4.0 |      0.33 / 0.33 |
| Ruler drag: gap between new pictures, p95    |          98 ms |           501 ms |       511 ms |         3,057 ms |
| 1x play, 10 s: pictures per second           |             30 |               29 |           30 |               29 |
| 1x play: dropped of 300                      |              3 |                6 |            5 |               12 |
| 1x play: gaps over 42 ms                     |             55 |                4 |           22 |               52 |
| 1x play: picture gap p95                     |          50 ms |            33 ms |        50 ms |            50 ms |
| Ctrl+wheel zoom, 16 steps: frame p95         |     20 / 20 ms |     122 / 240 ms |   45 / 48 ms |     200 / 201 ms |
| Ctrl+wheel zoom: frames over 25 ms           |              1 |                7 |           20 |               15 |
| Razor at the playhead, key to timeline       |      6 / 15 ms |     590 / 793 ms |   47 / 77 ms | 2,181 / 2,627 ms |
| Undo of the razor, key to timeline           |     54 / 74 ms |     575 / 840 ms | 111 / 221 ms | 2,511 / 3,131 ms |
| Ripple delete, key to timeline               |     18 / 21 ms |      91 / 120 ms |  83 / 120 ms |     424 / 493 ms |
| Ripple delete, key to picture                |   603 / 617 ms |     632 / 667 ms | 691 / 795 ms | 2,761 / 2,930 ms |
| Undo, key to timeline                        |     48 / 55 ms |     556 / 584 ms | 114 / 183 ms | 2,568 / 3,322 ms |
| Undo, key to picture                         |   361 / 450 ms |     578 / 612 ms | 538 / 711 ms | 2,627 / 3,390 ms |
| Trim drag, 40 moves: editor frame p95        |     19 / 20 ms |       21 / 24 ms |   28 / 33 ms |      53 / 109 ms |
| Trim drag: edge pictures shown in the viewer |             21 |               11 |           25 |                6 |
| Move drag, 40 moves: editor frame p95        |     19 / 19 ms |       18 / 19 ms |   24 / 30 ms |      38 / 100 ms |
| Agent writes the file, to picture            |   493 / 504 ms |     566 / 663 ms | 563 / 802 ms | 2,219 / 2,710 ms |
| Undo of that write, to picture               |   381 / 412 ms |     499 / 628 ms | 502 / 738 ms | 1,906 / 2,461 ms |
| Agent edits over MCP, call to picture        |   590 / 614 ms |     no such tool | 730 / 973 ms |     no such tool |
| Browser memory after the session (PSS)       |       1,402 MB |         2,629 MB |     1,250 MB |         3,013 MB |
| Server memory after the session (PSS)        |         408 MB |           533 MB |       346 MB |           517 MB |

What each row does, in both editors:

- **Open**: navigation to the first screencast frame showing source frame 0, and to the timeline listing all 100 shots. Three navigations per run in one browser; the first of the first run follows a fresh server.
- **Ruler drag**: from shot 10 to shot 40 at Fit, a pointer move about every 16 ms for three seconds. The gap row includes the wait from the drag's start to its first picture.
- **Play**: a ruler click into shot 22, Space, then ten seconds of the tab's composited frames, read by number. A gap between new pictures is rounded to whole display frames, since the capture times jitter by a few milliseconds (28 to 37 ms for a picture held two frames at 60 Hz). The editor's frames are its page's animation frames over the same time.
- **Zoom**: Ctrl+wheel over the timeline, one step a displayed frame, timed by the editor page's animation frames.
- **Razor**: click the shot, then Cutroom's E (razor at the playhead) or Studio's S (split the selected clip). Timed from the key to the frame after the timeline shows one more clip. The picture does not change.
- **Ripple delete**: click the shot, then Delete. Studio's ripple is on by default and closes the gap on its main track; Cutroom also ripples the music, as Resolve does with auto-select tracks on.
- **Trim and move drags**: zoomed until the clip is 160 px wide, 40 pointer moves at about 60 Hz: shot 30's end 60 px left, title 6 by 80 px. Each was checked to have applied and to undo. Both editors show the trim's edge frame in the viewer while dragging; Cutroom shows about twice as many.
- **Agent edit**: Studio's agent tools (WebMCP: select, inspect, seek, set style or text, transform, animate) have no timing edit, so its agent edits the file. Both editors were timed from writing a ripple-deleted `index.html` to the picture; Cutroom also from a `timeline_edit` remove-with-ripple call, after a `timeline_read` that is not timed.
- **Memory**: proportional set size of the browser's process tree and of the server's, after the session. Playwright keeps response bodies for its Network domain, which overstates the browser's figure for both editors (see Footage pipeline, Memory). Studio's server includes the headless Chrome it starts for thumbnails.

Run it with `bun run build`, then `node scripts/bench-vs-studio.ts --editor cutroom|studio --throttle 1|4 --runs 3 --out <file>`, and `--summary <files>` for the medians. It runs under Node because Playwright's library loses its browser under Bun, takes about four minutes a run, and is not run in CI. The project, about 125 MB, goes in `~/.cache/cutroom-vs-studio-bench` unless `--dir` says otherwise.

### Graded footage

`--grade` puts one light grade (warmer, a little more contrast, an S-curve) on all 100 shots, as `data-color-grading`. On November 18, 2026, one run each at 1x on the colour grading branch, with other tests running on the same machine:

| Operation                            | Ungraded | Every shot graded |
| ------------------------------------ | -------: | ----------------: |
| Ruler drag: new pictures per second  |     15.6 |              10.9 |
| Ruler drag: gap between pictures p95 |    84 ms |            114 ms |
| 1x play: pictures per second         |     29.4 |              29.3 |
| 1x play: gaps over 42 ms             |        7 |                38 |
| 1x play: picture gap p95             |    33 ms |             50 ms |
| Reopen to frame 0 shown              |   750 ms |            899 ms |
| Ripple delete, key to picture        |   609 ms |            649 ms |
| Browser memory after the session     | 1,409 MB |          1,507 MB |

HyperFrames' runtime draws a graded video through one shared WebGL context and copies the result into a canvas beside the clip, every displayed frame while it plays. These figures predate the 3D LUT compositor and the runtime's removal of redundant playback redraws. Use `--footage-only --grade --slider` to measure scrubbing, playback and slider response without running the edit suite. Add `--pipeline` to try GPU footage playback on the same authored project. `--pipeline-compatible` still makes the older control fixture. Use `--ripple-only` to measure scrub, playback, ripple delete and undo in one session.

### GPU footage playback on the authored project

The original 100-cut project used HyperFrames even with GPU footage playback enabled. Its empty root GSAP timeline stopped classification first. With that removed, the head's project-local GSAP path stopped it. With the library moved to Cutroom's usual path, the standard `clip` class still disqualified all 100 videos. The pipeline now draws those videos under the original titles and both placements of the scene. The bench project needs no markup changes.

Headed Chromium, 1720 × 1050, `--editor cutroom --grade --ripple-only --runs 1` with the original project and the setting off or `--pipeline`. CPU throttling applied to the editor and the preview. Playback stayed at normal speed.

| CPU | GPU setting | Scrub pictures/s | Scrub gap p95 | Playback pictures/s | Long playback holds in 10 s | Ripple / undo to picture, median | Browser PSS |
| --- | ----------- | ---------------: | ------------: | ------------------: | --------------------------: | -------------------------------: | ----------: |
| 1×  | Off         |              9.6 |        146 ms |                29.2 |                          11 |                     784 / 584 ms |   1,383 MiB |
| 1×  | On          |             21.9 |         58 ms |                29.1 |                          16 |                       86 / 75 ms |   1,639 MiB |
| 4×  | Off         |              5.0 |        288 ms |                15.9 |                         133 |    No validated seek before edit |   1,155 MiB |
| 4×  | On          |             12.8 |        146 ms |                28.2 |                          26 |                     350 / 163 ms |   1,527 MiB |

At 4× with the setting off, an earlier run measured 27.6 pictures/s and 97 long holds. It also lost a pre-edit picture check. Treat the playback spread as run-to-run variation. The 4× off memory sample covers the session without the five ripple edits, so it is a weaker comparison.

A local check used a stream copy of an OBS 1080p60 HEVC recording on a millisecond clock. The timeline had eight graded cuts, alternate static zooms, a title and two animated scene placements. The pipeline owned the footage after the editing proxy was ready. On a mostly static screen recording, the headed screencast saw 2.3 → 3.6 visibly changed pictures/s while dragging and 1,119 → 1,040 MiB browser PSS at 1×. At 4× it saw 2.6 → 3.0 changed pictures/s and 1,038 → 1,030 MiB. Playback had too little picture motion to estimate dropped frames from those captures. Those counts describe visible changes in the recording.

#### Readiness follow-up

Rechecked November 18, 2026 on Chromium 155, headed at 1720 × 1050. Each row is one `--grade --ripple-only --runs 1` session per revision, from `6e3b754b` to the colour and playback changes. Both revisions used the same screencast reader, calibrated to Chromium's reported capture width. All five ripple and undo samples matched their expected source frames in each run. Playback ran at normal speed at both CPU settings.

| CPU, GPU setting | Scrub pictures/s | Long holds in 10 s | Ripple / undo to picture, median ms | Browser PSS, MiB | PSS after closing screenshot-reading tab, MiB |
| ---------------- | ---------------: | -----------------: | ----------------------------------: | ---------------: | --------------------------------------------: |
| 1×, off          |      14.6 → 11.2 |            16 → 48 |               841 / 569 → 816 / 582 |    1,464 → 1,474 |                                     — → 1,087 |
| 1×, on           |      26.9 → 29.4 |              3 → 4 |                   79 / 76 → 72 / 75 |    1,640 → 1,686 |                                 1,293 → 1,236 |
| 4×, off          |        4.3 → 4.0 |           92 → 102 |               883 / 737 → 884 / 815 |    1,446 → 1,444 |                                 1,109 → 1,103 |
| 4×, on           |      12.9 → 13.2 |              8 → 4 |               343 / 157 → 268 / 163 |    1,626 → 1,694 |                                 1,299 → 1,253 |

The 1× graded control varied between 16 and 48 holds across these two runs. Three more alternating runs per build with GPU playback off, on a quiet machine (load average near 1), measured 7, 61 and 14 holds on main `2f34460f` and 62, 18 and 14 on this change, with scrub at 13.6 and 15.0 pictures a second and ripple to picture at 767 and 773 ms (medians). The off path runs no new code, and its holds vary this much between runs of the same build. Two further graded GPU runs on the playback build measured three and four holds. In ungraded footage-only sessions on the combined build, enabling GPU playback gave 6 → 3 holds at 1× and 6 → 7 at 4×.

Closing the screenshot-reading tab removed 347 to 450 MiB from the graded GPU-on readings. The remaining PSS dropped by 57 MiB at 1× and 46 MiB at 4× across the two builds with GPU playback enabled. It still sat 149 to 150 MiB above GPU-off on the combined build after the five edits. The first 1× control was sampled before the second PSS reading was added.

A ten-second headed trace of graded GPU playback showed the preview main thread sampling its clock every 16.7 ms. The editor sometimes started canvas draws 50 to 67 ms apart or skipped a timeline frame. At p95 it took 0.21 ms to get the decoded picture and another 2.35 ms to upload and draw it. The decoder queued up to 29 samples while preparing pictures. The holds occurred even when the requested picture was already decoded. The canvas now uses the preview's timestamped clock at the display refresh, with a fallback to the reported runtime state when buffering or when clock messages stop.

The footage pipeline now shares the demuxed index and up to 12 MiB of compressed data between a source's two playback decoders. The shared decoded frame cache drops from 192 to 128 MiB, including the last pictures of old sources when needed. The all-intra scrub decoder keeps four pictures and uses low-latency decoding. The grade texture cache holds up to 2.2 MiB. A native media check during the 100-cut test found three videos with metadata with the setting off and zero with it on, where all 100 video elements were parked. Chromium's decoder pools, Playwright's network buffers and the benchmark's image reader also contribute to browser PSS.

The 60 fps layered chart check selected the correct source frame in all 12 positions. Using the source matrix in preview and export cut its mean RGB error from 9.35 to 2.46 levels out of 255. The graded swatches and luma ramp measured 0.75 and 0.67 levels on average, both with a maximum error of 2. A 12-frame MP4 around the cut at 1:03 of the full authored benchmark, with the title and scene visible, averaged 2.14 levels before and after the colour fix. The largest per-channel error was 166 and the worst frame's 99th-percentile error was 24.

**Recommendation.** Keep the setting opt-in. The composed benchmark still exceeds the grading-only colour bound. GPU playback still uses more browser memory after repeated edits on the graded fixture. Confirm playback holds and browser memory on a moving recording in Electron before revisiting the default. Sources above the 1080p pixel budget, HDR and alpha stay in HyperFrames. Unproven root scripts, authored styles or adjustment effects can still require native compositing. A title or native clip below GPU footage uses HyperFrames for the overlap, with the pipeline resuming after it.

#### Desktop playback

The browser's screencast is unsuitable for counting Electron playback holds on this machine.
Its frame stream can drop samples while the viewer continues updating. The desktop benchmark
reads the same source frame numbers directly from the Hyprland output via Wayland screencopy.
It copies one pixel row in the viewer for each sample and retains the compositor timestamp and
decoded number. A red block distinguishes a valid frame zero from a blank picture. Hyprland
timestamps the copy after it commits to the display backend. The capture asks the compositor
for output frames even when the picture is held, so both settings run with the same readback.
The X11 runs use this capture path too, because XWayland windows appear on the same Wayland
output.

To check the reader, a Chromium app window showed 30 fps numbers with five consecutive frames
held back once a second, for six seconds. At 143.981 Hz, the compositor captured 864 samples
and read 151 pictures, including the picture at the window boundary. Chromium's screencast
captured 360 samples and read 150 pictures. Both found the six programmed holds. The longest
was 202 ms from the compositor and 201 ms from the screencast. The largest compositor sampling
gap was 10.56 ms, below the 33.33 ms period of a source frame.

The exact-frame check also caught a ripple delete that showed the right footage and then
showed the deleted shot again. On main `3fbbcb36`, Electron Wayland, Electron XWayland and
Chromium XWayland all showed source frame 1005 after deleting shot 22, then returned to 3405
while the old preview was retained. The new plan had removed the clip's ID from the GPU list,
so the old document loaded its copy above the canvas. The bridge now keeps that clip parked
in the old document. An explicit assignment to native playback still releases the clip.

The 1080p fixture keeps the 100 graded cuts, music, titles and scenes from the earlier benchmark.
Each run opens a fresh project and browser profile, times the first frame zero after navigation,
and waits for the scrub proxy before the playback and drag samples. Playback runs for ten
seconds at 1x after a half-second lead-in. Scrub is a three-second horizontal ruler drag. The
ripple and undo samples are from shots 22, 24 and 27, timed to the expected source picture.
PSS is the browser process tree after these operations, excluding Electron's Bun server. The
4K fixture plays 30 seconds at 1x from a 3840 × 2160, 30 fps, 32 Mbit/s H.264 source with a
one-second GOP. It has 30 cuts, six titles and a music bed. With the setting enabled, the 4K
source still uses HyperFrames because it exceeds the pipeline's source-pixel budget.

On November 20, 2026, the desktop ran Electron 45.2.3 with Chromium 156.0.8078.80.
The browser control ran Chromium 155.0.8059.84. The machine had an i5-14400F, an RTX 5060
on driver 615.78.08, and Hyprland 0.56.2. Each accepted run used the same 1920 × 1080,
143.981 Hz output. The second 60 Hz monitor stayed connected. Background load varied during
the runs. Runs interrupted by a focus change or excessive capture gaps were repeated.

Each cell reads **off → on**. Values are medians. The 1080p GPU-on rows use the build with
the ripple fix (`60fe861c`), and the unchanged off path includes controls recorded before
and after it. Settings ran in both orders. Ripple and undo pool three shots per run.

| Host              | Runs per setting |  Pictures/s | Long holds / 10 s | Scrub pictures/s |  Ripple ms |   Undo ms |     Open ms | Browser PSS MiB |
| ----------------- | ---------------: | ----------: | ----------------: | ---------------: | ---------: | --------: | ----------: | --------------: |
| Electron Wayland  |                3 | 27.1 → 30.0 |          100 → 10 |       7.6 → 46.5 | 1837 → 113 | 1423 → 88 | 2969 → 1535 |      939 → 1174 |
| Electron XWayland |                3 | 29.7 → 30.0 |            33 → 5 |      16.9 → 29.9 |   965 → 90 | 708 → 134 | 1717 → 1003 |      936 → 1081 |
| Chromium XWayland |                3 | 29.9 → 30.0 |            34 → 6 |      17.3 → 29.8 |   983 → 84 |  764 → 98 |  1834 → 997 |     1065 → 1208 |
| Chromium Wayland  |                1 | 30.1 → 30.2 |           70 → 67 |      17.2 → 45.1 | 1015 → 129 |  734 → 85 | 1868 → 1025 |     1061 → 1288 |

For 4K H.264, the footage path stayed native with either setting. The Chromium rows are
one pair per display path and give a reference for the desktop runs.

| Host              | Runs per setting |  Pictures/s | Long holds / 30 s | Longest hold ms |     Open ms | Browser PSS MiB |
| ----------------- | ---------------: | ----------: | ----------------: | --------------: | ----------: | --------------: |
| Electron Wayland  |                3 | 28.8 → 29.9 |          219 → 98 |        195 → 69 | 1608 → 1189 |     3174 → 3541 |
| Electron XWayland |                3 | 29.8 → 29.8 |          38 → 102 |         77 → 83 | 1250 → 1181 |     3465 → 3540 |
| Chromium XWayland |                1 | 29.9 → 30.0 |         157 → 140 |         76 → 77 | 2134 → 2300 |     3899 → 3878 |
| Chromium Wayland  |                1 | 29.9 → 29.8 |         146 → 130 |         77 → 84 | 1186 → 1270 |     3440 → 3380 |

**Decision.** Keep the setting opt-in. At 1080p the corrected pipeline improved playback,
scrub, first picture, ripple and undo in both Electron modes and in the Chromium control.
The output capture measured 30.0 pictures/s in Electron Wayland with GPU playback,
replacing the earlier screencast estimate of 23.6. Browser PSS at 1080p increased by 145 MiB on Electron XWayland and
235 MiB on Electron Wayland.

The 4K XWayland playback rates were even to a tenth of a picture per second, but the three
hold comparisons were 133 → 117, 31 → 37, and 38 → 102. Both settings used the same native
path, and the direction changed between runs. These measurements leave 4K cadence parity
unresolved. The Chromium Wayland reference also showed more 1080p holds than the XWayland
reference with either setting. Cadence varied with display path and background load. The
stale preview was the reproducible fault.

To run locally on Hyprland, use an unrotated display at scale 1 and leave the benchmark window
in front. The tool uses Node with TypeScript stripping, Bun, FFmpeg, a C compiler, the Wayland
client headers and `wayland-scanner`. It launches a full-screen window at the display resolution
with private data and project directories. `--electron` and `--chromium` select alternate executables if needed. The code
generator below uses the
[pinned wlr-screencopy protocol](https://github.com/swaywm/wlr-protocols/blob/b010a03648b88d143236de193bddbfea0c08bc84/unstable/wlr-screencopy-unstable-v1.xml).

```sh
bench_dir=$(mktemp -d /var/tmp/cutroom-electron.XXXXXX)
bun run build
bun scripts/desktop.ts --build-only
curl -fsSL https://raw.githubusercontent.com/swaywm/wlr-protocols/b010a03648b88d143236de193bddbfea0c08bc84/unstable/wlr-screencopy-unstable-v1.xml -o "$bench_dir/screencopy.xml"
wayland-scanner client-header "$bench_dir/screencopy.xml" "$bench_dir/screencopy.h"
wayland-scanner private-code "$bench_dir/screencopy.xml" "$bench_dir/screencopy.c"
cc -O2 -I "$bench_dir" scripts/desktop-playback/screen.c "$bench_dir/screencopy.c" -lwayland-client -o "$bench_dir/screen"
node --input-type=module -e '
  import { makeProject } from "./scripts/bench-vs-studio-project.ts";
  await makeProject(process.argv[1] + "/master-1080p", true, false, "1080p");
  await makeProject(process.argv[1] + "/master-4k", false, false, "4k");
' "$bench_dir"
flock /tmp/cutroom-e2e.lock node scripts/bench-desktop-playback.ts --dir "$bench_dir" --host chromium --setting off --validate
flock /tmp/cutroom-e2e.lock node scripts/bench-desktop-playback.ts --dir "$bench_dir" --host wayland --setting on --size 1080p
```

Use `--host x11` for Electron on XWayland, `--host chromium` for Chromium on XWayland,
and `--host chromium-wayland` for Chromium on Wayland. Use `--setting off` for the control and `--size 4k` for the sustained run. `--out` saves the JSON
summary. Run paired settings in both orders. On a 144 Hz display, a long hold is a picture
gap over 38.2 ms, half a display interval longer than the maximum five refreshes needed to
show a regular 30 fps picture. The runner counts source pictures that could fit into gaps
between capture samples. It rejects a window if more than 1 out of 300 pictures or more than
4 out of 900 could go unseen. Focus changes invalidate a run.

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

## Work counts

Frame-time budgets measure what users feel, but on shared CI runners they need repeated runs and still fail when a runner is slow (see Zoom and ripple edits). `e2e/timeline-work-performance.spec.ts` gates the same hot gestures on how much work they cause instead, which depends on the code and not on the runner. The idea comes from Powermove's structural timeline tests; no code was taken.

Each gesture runs once on the 500-clip `timelineWorkload` under a `devtools.timeline` trace. The counts are:

- **Forced style and layout**: recalculations and layouts that run inside script, because script read style or geometry after changing the page. The browser would otherwise do that work once, when it draws. This is what a misplaced `getBoundingClientRect` or `offsetWidth` adds.
- **Layouts** and **restyled elements** in the editor, from the trace's `Layout` and `UpdateLayoutTree` events for the editor's frame.
- **React commits**, through a devtools hook installed before the editor loads.
- **Clip-body redraws**: full clears or resizes of the `.tl-bodies` canvas.
- **Forced style and layout in the preview**, the sandboxed frame that runs in its own renderer. Playback is counted per frame the preview drew, since its runtime plays on its own clock.

Gestures are driven a fixed number of steps, each followed by animation frames, so counts follow inputs rather than time. Edits are measured until the viewer shows the new revision and the editor has had no commit or redraw for 30 frames. Restyled elements are not budgeted where an easing or slide decides how many frames run (key zoom and the edits).

Measured on main `f736424`, November 15, 2026, Chromium 155 at 1720x1050: six unthrottled runs and runs with the editor's CPU throttled 4x and 6x. Every budget is the highest count seen plus a margin.

| Gesture                     | Count                 |    Main | Budget | Deliberate regression                                              | With it |
| --------------------------- | --------------------- | ------: | -----: | ------------------------------------------------------------------ | ------: |
| Ctrl+wheel zoom, 16 steps   | Restyled elements     |   2,387 |  3,600 | `--ppf` inherited again                                            |  27,945 |
| Ctrl+wheel zoom, 16 steps   | Forced style, layout  |      32 |     40 |                                                                    |         |
| Scroll, 60 steps of 8 px    | Layouts               |       5 |     10 |                                                                    |         |
| Key zoom, 6 eased steps     | Layouts               |      18 |     24 |                                                                    |         |
| Drag a clip, 40 moves       | Forced style, layout  |       7 |     12 | Read the readout's `offsetWidth` after the per-move writes         |      64 |
| Trim a clip's end, 40 moves | Forced style, layout  |     4-6 |     10 | Same                                                               |      52 |
| Scrub the ruler, 40 moves   | Forced style, layout  |       0 |      4 | Read the playhead's bounds after writing its position, every frame |      82 |
| Scrub the ruler, 40 moves   | React commits         |       2 |      4 | Render the timeline on every playhead frame                        |      42 |
| Play 1x for 120 frames      | Forced style, layout  |    9-14 |     20 | Read the playhead's bounds after writing its position, every frame |     141 |
| Play 1x for 120 frames      | React commits         |     2-8 |     15 | Render the timeline on every playhead frame                        |      81 |
| Play 1x for 120 frames      | Preview forced, frame |   13-15 |     24 |                                                                    |         |
| Ripple delete, undo, W      | React commits         |   24-34 |     45 |                                                                    |         |
| Ripple delete, undo, W      | Preview forced        | 744-775 |    900 |                                                                    |         |

The spec budgets every count for every gesture; the table shows the ones each regression tripped and a few others. All counts except clip-body redraws while scrolling (1 to 9, as filmstrip frames arrive) and the preview's work while scrubbing (1,028 to 1,493, as its seeks coalesce) were identical or within a few across runs and throttling, while frame counts for the same gestures varied up to threefold. The check takes about 40 seconds locally, most of it building the workload. Set `CUTROOM_WORK_THROTTLE=4` to see the counts hold under CPU throttling.

Every edit forces about 750 style recalculations in the preview, one or two per clip, on every run. That is the current in-place edit path's cost on 480 media elements, and the budget holds it there.

The frame-time budgets above and in Trim preview, Position preview and Track heights stay. They measure what a user sees, and some regressions (a slow style pass over the same elements) change time without changing any count. The counts catch the common regressions on any runner; the ceilings catch the rest when it is large. The noisiest timing assertion, Position's added late-frame rate during playback, already pairs with exact counts of observations and box reads per run, so it was left as it is.

## Timeline reads

Each change should read the timeline once. One edit writes several project files (the composition, `cutroom.json`, `.cutroom/review.json`, and their temporary copies), and the server announces each as a project file event. The editor used to read the timeline and history for every event, once more when the review notes it reloaded on those events changed, and once more after its own edit. It now gathers the events of one burst for 100 ms and answers them with one queued read. An edit's answer is already the view a read returns, so the edit itself reads only the history. Undo and redo answer without a view, so they still read once themselves and once for their file events.

Measured on November 15, 2026 with Chromium 1720x1050 on a shared machine: five rounds of razor, undo, redo and an agent marker over HTTP, on the interview workload (29 clips) and on 300 one-second element clips. Reads are counted per action as `GET /timeline` / `GET /history`. Read time is the sum of those requests' time to first byte, median of five. Server CPU is the server process's user and system time over the same window, in 10 ms steps, and includes the edit itself and preview work.

| Action, 300 clips | Reads before | Reads after | Read time before | Read time after | Server CPU before | Server CPU after |
| ----------------- | -----------: | ----------: | ---------------: | --------------: | ----------------: | ---------------: |
| Edit (E)          |    5-7 / 5-7 |       1 / 2 |           240 ms |           72 ms |            570 ms |           500 ms |
| Undo              |    4-6 / 4-6 |       2 / 2 |           222 ms |           84 ms |            550 ms |           500 ms |
| Redo              |    4-6 / 4-6 |       2 / 2 |            48 ms |           26 ms |            240 ms |           230 ms |
| Agent edit        |        3 / 3 |       1 / 1 |            27 ms |            8 ms |            100 ms |            80 ms |

The interview workload shows the same counts, with read time falling from 28 to 5 ms per edit and 16 to 5 ms per agent edit. An outside edit now shows about 70 ms later (median 153 to 225 ms from the request to the last read on the interview workload), the cost of waiting for the rest of its burst. The editor's own edits are unaffected: they show before the server answers. `e2e/timeline-reads.spec.ts` fails when an edit, an undo or an agent edit reads more than this.

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

The performance test now collects `cutroom:position-observation` measures from the isolated preview and requires the median of three per-run maximum observation durations to stay below 5 ms. Nothing selected must produce zero measures. During playback it also counts callback-entry gaps above 1.5 times the measured display interval, with and without the Position-edited title, in six pairs that alternate which condition goes first. Late frames pooled over all six selected runs, as a share of all their frames, may exceed the unselected share by less than five percentage points. Scrubbing is judged differently, as described below. The direct observer budget catches repeated costly checks that a frame percentile can hide. Like #63, it tolerates one isolated slow run and retains every outlier. `position-observation.json` records each duration and callback gap, and `CUTROOM_POSITION_TIMING_OUT` saves that attachment locally.

On November 11, 2026, installed Chromium 155 on the same 500-clip workload measured a maximum observer duration of 0.9 ms in both playback and scrubbing. All six unselected runs produced zero observations. Playback had two late callbacks in each run, with either selection; scrubbing had 2/4/2 without selection and 1/2/2 with the positioned title. A temporary local change stalled alternate observations for 30 ms. The new per-observation gate failed at 30.4 ms; the injected change was removed. These local results establish that the gate catches that regression, not that every host has the same timings.

Playback used three pairs, always unselected first, and compared median per-run late-frame rates until November 15, 2026. It failed CI twice with no Position change, at 5.6 and 5.7 points. In 60 CI performance jobs before the change, selecting the title added 0.26 late frames per 2.5-second run on average (7.55 to 7.81, about 0.2 points), and Position work totalled about 3 ms per run. One run alone ranged from 2 to 34 late frames, so a median of three passed that swing through: the difference ranged from -1.9 to +5.7 points. After the change, 20 runs across four CI runners ranged from -2.5 to +2.1 points (median +0.1). A temporary local bridge change that stalled 30 ms on every twelfth frame while a clip was observed during playback, outside the measured spans, failed the pooled gate at 6.6 and 7.3 points.

Scrubbing used the same late-frame comparison until November 14, 2026. It failed on `main` three times with no Position change and passed on rerun. In 59 CI performance jobs, the late-frame rate with nothing selected ranged from 2% to 39% between runners, because the runtime's own work per scrubbed frame sits near the 1.5-interval threshold. The selected-minus-unselected difference ranged from -6.2 to +13.1 points against a 5-point limit. With a 3 ms stall injected into every outline read, that gate failed one local run in two.

Scrubbing now runs five pairs of 90 ruler steps, alternating which condition goes first, and gates on two measured quantities:

- Position work per scrub step: the selected run's observation and outline-read durations summed and divided by 90, median of five runs, below 2 ms. This catches reads that each stay under the 5 ms per-read budget but add up on every seek.
- Editor CPU ratio: the editor main thread's CPU time (`ThreadTime` from Chromium's `Performance.getMetrics`) over the scrub with the title selected, divided by the paired unselected scrub, median of five pairs, below 1.3. CPU time does not grow when a busy runner deschedules the browser. This catches the editor's own cost of following the selected clip, such as handling each warning, at roughly 4 ms per step and above on this workload. The sandboxed preview runs in another process, where the runtime uses about 50 ms of CPU per step; Position work there is too small to see against that, which is why it is measured directly.

Scrub late-frame counts stay in the attachment but no longer gate. Local results on November 14, 2026, installed Chromium at 1720×1050:

| Condition                        | Position ms per step | Editor CPU ratio | Result |
| -------------------------------- | -------------------: | ---------------: | ------ |
| Idle, three runs                 |         0.53 to 0.59 |     1.04 to 1.14 | pass   |
| 24 busy loops on 16 cores, three |         0.56 to 0.95 |     0.98 to 1.12 | pass   |
| 3 ms stall in each outline read  |                 3.56 |             1.07 | fail   |
| 3 ms stall in each observation   |                 3.59 |             1.10 | fail   |
| 6 ms stall handling each warning |                 0.60 |             1.46 | fail   |
| 4 ms stall handling each warning |                 0.54 |             1.42 | fail   |

Four CI runs of this change on GitHub's runners, whose scrub late-frame rates with nothing selected ranged from 18% to 39%, measured 0.54 to 0.67 ms per step and CPU ratios of 1.09 to 1.11.

The stalls are `CUTROOM_POSITION_READ_STALL_MS`, `CUTROOM_POSITION_OBSERVATION_STALL_MS` and `CUTROOM_POSITION_EDITOR_STALL_MS`. In those four stalled runs the old late-frame difference was 4.5, -1.7, -3.0 and 0.0 points, all inside its limit.

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

The picture-paint gate measures native pointer-down `timeStamp` to a task after the outline update's next animation frame, including that rendering opportunity. It makes twenty alternating video/title clicks in each of three fresh loads, after drawn clip bodies and a 4.5-second media warm-up. The median cold click and at least 95% of all 60 clicks must paint within 50 ms, three frames at 60 Hz. Every click has a 150 ms ceiling, including an isolated stall. CI Chromium 158 with SwiftShader measured 35.2 ms against the previous 33 ms ceiling. That two-frame ceiling was too close to normal runner variation. The gate runs without Playwright's trace and checks the inspector only after each paint is stamped. A trace snapshots the whole 500-clip page after every click and check, and a role locator walks it too, both on the editor's main thread. Under 4x CPU throttling those snapshots took about 25 ms per click, often between the outline's frame and the task that stamps its paint, so the gate timed the test harness along with the selection. CI failed at 50.8, 52.2 and 54.6 ms while the same commit's twin run passed. `picture-selection-paint.json` and `CUTROOM_PICTURE_TIMING_OUT` retain every pointer, outline and after-paint timestamp, cold click and bridge hit cost. This includes a rendering opportunity, not physical display scan-out.

Negative controls run inside actual preview reads without changing production code:

- `CUTROOM_POSITION_READ_STALL_MS=10` stalls the selected title's geometry read.
- `CUTROOM_POSITION_OBSERVATION_STALL_MS=10` stalls the selected title's computed-style read.
- `CUTROOM_PICTURE_HIT_STALL_MS=60` stalls `elementsFromPoint`. This replaces the old 40 ms control so it clearly exceeds the 50 ms paint budget.

On November 16, 2026, main `3e3c0d3` and this measurement ran on the same production build, installed Chromium 155 headless at 1720x1050, five sessions of three loads each:

| Measurement                | Session medians, unthrottled |   Load maxima, unthrottled | Session medians, 4x CPU throttle |
| -------------------------- | ---------------------------: | -------------------------: | -------------------------------: |
| With trace and early check |              35.9 to 41.7 ms | 31.5 to 59.8 ms, 3 over 50 |                    125 to 139 ms |
| Without                    |              28.1 to 30.6 ms |            28.0 to 32.6 ms |                     94 to 120 ms |

The 60 ms hit stall still fails it, at 121 ms.

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

### Dragging on the picture

A drag sends one `boxes` request when it starts, so a dragged clip can snap to the others drawn on the picture. It answers with every visible clip's box and costs the preview 0.6 to 1.1 ms on the 500-clip workload; the drag snaps to the frame alone until it arrives and never waits for it. Each pointer move then compares the box's three edges with a few dozen lines, with no further bridge requests. The safe-zone and grid layer is static and never redrawn during a drag.

`bun run test:perf --grep 'picture drag'` moves the full-frame talking head across the 500-clip workload in 30 steps, one per animation frame, each wider than a snap's hold. It times each move from its `pointermove` to a task after the frame in which the outline lands at the new place. The median of the three loads' median delays has a 67 ms budget. A separate 100 ms budget applies to the median first move and to at least 95% of all moves pooled across the three loads. Every move has a 300 ms ceiling so an isolated long stall still fails. Moves the browser coalesces into one outline update count once, from the earliest. `CUTROOM_PICTURE_DRAG_OUT` saves every sample and the per-load maxima.

On November 16, 2026 production builds of main (`8a21e4a`) and this change ran alternately, two sessions each of three fresh loads, on installed Chromium 155 headless with hardware ANGLE on the RTX 5060, at 1720x1050, muted:

| Build             | Move median, per load | Slowest move, per load | `boxes` request |
| ----------------- | --------------------: | ---------------------: | --------------: |
| main              |       26.7 to 27.1 ms |        55.5 to 61.5 ms |            none |
| snapping to clips |       27.0 to 27.5 ms |        52.0 to 67.3 ms |   0.6 to 1.1 ms |

The slowest move is the drag's first on both builds, and its spread is the same run-to-run noise. Picture selection paint in the same sessions: 33.2 and 35.2 ms on main, 30.7, 33.2 and 38.7 ms with this change, against its 50 ms gate.

## Paused timing edits

A saved timing-only edit can update an isolated, script-free preview in place while stopped. The compiler policy checks root and mounted source files before runtime injection, including template contents and hoisted fallback markup. Only the exact pinned GSAP library is exempt from the authored-script restriction. Authored timelines, handlers and other scripts always reload. Before a patch, the bridge compares the current live DOM with its last confirmed structure. It applies canonical timing to linked partners together, then confirms the decoded hold canvas through the existing seek/paint path.

Only approved, paused documents serialize refreshes, with one operation in flight and one latest pending invalidation. Scripted documents and playback use the ordinary reload path: each newer invalidation immediately replaces its superseded candidate. Scripted responses do no dependency fingerprinting or timing snapshot construction, contain no timing policy stamp, and make no eligibility request before inspection or painting. A deterministic HTTP regression test observes zero calls to both timing helpers for a scripted response and one each for an eligible response. Browser tests also assert zero timing/eligibility requests throughout scripted loads and bursts. A forged bridge hint can start an asynchronous authorization request, but cannot grant eligibility or serialize scripted reloads.

### Scripted fallback comparison

On November 14, 2026, production builds of main `1c0feeb` and implementation `be50283` ran on Bun 1.4.4 and installed Chromium 155.0.8059.84. Headless Chromium used hardware ANGLE on NVIDIA GeForce RTX 5060, verified through WebGL. The shared host was an Intel Core i5-14400F with 32 GB RAM, at 1720×1050 with audio muted. No packages, browsers or media were downloaded.

The interview has ten linked picture/sound cuts, four b-roll clips, music and four authored GSAP titles. It always takes the full reload path. Each block starts from an identical saved project/database/media snapshot in a fresh browser context, warms for 4.5 seconds and performs three one-frame Start edits, an eight-edit 4/s burst and an eight-edit 8/s burst. Blocks alternate which build runs first within each pair. Two unchanged batches supply twelve pairs, 36 single edits and twelve bursts per rate per build. The second batch was added because the first batch's 4/s difference was uncertain; both batches are included.

The metric is browser Enter keydown to confirmed saved picture, including save, watcher, compilation, decoded capture and paint. Burst settle starts at the last key. Every burst saved all eight edits, and the confirmed live document's timing had to equal the final canonical snapshot. It does not measure physical display scan-out. The selected interview title is offscreen at the parked frame, so this measures confirmed replacement, not a visible title transition. The separate budget below requires changed pixels.

| Interview operation                       |     Main |  Revised | Median change |
| ----------------------------------------- | -------: | -------: | ------------: |
| Single Start edit                         | 350.2 ms | 346.3 ms |         -1.1% |
| Eight edits at 4/s, settle after last key | 289.6 ms | 293.3 ms |         +1.3% |
| Eight edits at 8/s, settle after last key | 340.0 ms | 353.7 ms |         +4.0% |

These results remove the reviewed large burst penalty without establishing an interview speedup. The remaining median differences are smaller than one 60 Hz paint interval. Paired mean differences were -2.2, +15.7 and +9.6 ms. Bootstrap 95% intervals across the twelve paired block differences were -11.3 to +8.0, +3.4 to +29.3 and -17.4 to +34.8 ms respectively. The 4/s paired mean still leans slower; the raw results preserve that limitation rather than claiming exact equivalence. Observed burst ranges were 269.9 to 301.9 / 272.1 to 344.0 ms at 4/s and 249.7 to 382.9 / 280.3 to 458.2 ms at 8/s, main/revised. Actual median first-to-last key spans were about 1.75 seconds and 0.89 seconds.

Revised bursts completed eight navigations each, matching main's replacement behavior; one main 8/s sample completed seven because a candidate was superseded before navigation committed. Both builds saved all eight edits. Scripted pages made zero timing or eligibility requests. Alternating the bridge-only transformation on the same compiled interview HTML, 35 measured pairs after warm-up, gave 29.9 ms main and 29.5 ms revised, compared with the review's 27.8/33.1 ms regression.

[Paired raw measurements](measurements/preview-scripted.json) include all 120 samples, paired differences, actual input cadence, navigation counts and bridge samples. Local drivers, complete event traces, logs and screenshots remain in `/home/akshar/.cache/cutroom-preview-r3-evidence/`.

### Visible live-path budget

`bun run test:perf` compares five live edits with five direct reloads on the same runner, alternating order on the identical plain 500-clip document. The control disables authorization in the parent and goes directly to reload. At frame zero, moving title-0's Start alternately hides and reveals it. Every sample asserts the expected visibility and different before/after PNG bytes before contributing to the budget. This replaces the earlier offscreen-title scenario.

Live median must be below 80% of reload median. This retains the relative budget that passed review, with margin for runner scheduling, instead of the old 600 ms absolute ceiling that failed in CI at 627 and 647 ms. It guards a material saving across machines; zero-work assertions separately guard scripted overhead shared by the comparison's two paths. With default Chromium SwiftShader and an injected 800 ms live request delay, the revised test failed at 1,188.8 ms live versus 916.1 ms reload, against a 732.9 ms limit. Visibility and changed-pixel checks passed before that expected latency failure.

The standalone hardware budget on final base `a3c7a6e` measured 417.3 ms live versus 900.9 ms direct reload, or 46.3% of reload time. The standard SwiftShader run measured 424.9/986.2 ms, or 43.1%. Each path had five samples, all with the expected visible title change and unequal PNGs. The control is the same revised build with parent authorization disabled, not a separate main build.

Full validation on `1c0feeb` passed 767 unit tests with five optional Electron/Whisper skips, and all 437 functional browser tests. An earlier partial browser run ended with SIGTERM after 72 passes; the complete unchanged rerun passed. Main advanced during the run. After rebasing onto `a3c7a6e`, types, 29 focused unit tests, six title/source/preview workflows and five repeated two-tab disk workflows passed. The disk assertion permits the required fail-closed reload when a shared pending compilation lacks eligibility proof, and verifies both tabs confirm canonical source-in. Its preceding MCP step still requires both live documents to remain.

All nine standalone performance checks passed in the repository's standard SwiftShader configuration, including the existing budgets. Hardware ANGLE passed seven of nine; the unchanged Position gates failed at +0.0698 added playback late-frame rate versus <0.05 and 88 ms selection paint versus ≤50 ms. A clean main `a3c7a6e` hardware comparison also failed selection at 132.8 ms; its Position observation case passed, with unselected/selected playback late-frame rates of 0.303/0.224 versus the revised run's 0.113/0.183. These unpaired diagnostic runs show substantial hardware timing variation and do not establish a Position regression or improvement. No existing limits changed. Both renderer configurations passed the new timing budget and repeated-edit resource checks on the revised build.

For context, the earlier five-run hardware comparison on main `6ea9beb` measured 835/420 ms for a plain 500-clip timing edit. That historical input used an offscreen title. Its interview result was 330/346 ms with full reloads. [Earlier raw measurements](measurements/preview-timing.json) remain labeled with their measured base; they are not the revised visible budget or the paired scripted table above.

The parity test retains its patched page and uses a second page for every fresh comparison. Tests cover rational 30000/1001 cut boundaries, linked source-in/rate and duration changes, titles, undo/redo, authored scripts, live DOM divergence, MCP/disk edits in two tabs, source races, refused saves and missing/failed/late acknowledgments. Burst tests hold the first real navigation behind a barrier until all eight saves complete: eligible documents have at most one active and one latest pending refresh; scripted documents replace the blocked candidate immediately. Both preserve every undo step. A shared pending compiler result can lack eligibility proof for one tab; the disk-edit check permits that safe reload and requires both tabs to confirm the final canonical source-in value. The preceding MCP edit still requires both documents to remain live.

The first timing edit can establish the managed stacking stylesheet and therefore reload. Nested compositions, source/script/CSS changes and stacking changes also reload. Added, removed and otherwise changed clips and a changed composition length update in place, with the exceptions in the architecture notes. An unavailable fingerprint disables live timing without preventing full preview loading. A live attempt has two seconds within the existing fifteen-second preparation deadline; fallback does not extend it. The pinned HyperFrames runtime is unchanged.

### Edits right after a burst

On November 15, 2026 the interview above (seeking to frame 90, the title stylesheet established) took one W and its undo, twelve D presses on the music bed and a lift, one key every 140 ms, then waited a second and undid the lift. The time is browser keydown of that undo to confirmed picture, six fresh projects per build, headless Chromium on a shared machine.

| Build       | Median |          Range | Undo in place | Document kept through the burst |
| ----------- | -----: | -------------: | ------------: | ------------------------------: |
| main        | 575 ms | 215 to 1551 ms |        2 of 6 |                          0 of 6 |
| this change | 135 ms |   92 to 157 ms |        6 of 6 |                          6 of 6 |

Two things reloaded it on main. The runtime positions a clip it has not laid out on its next layout pass, at most three times a second, so in a burst that pass changed an added clip's style after the update had confirmed the document, and the next comparison refused it. And the viewer abandoned an update the page had started; the page finished it but refused the next one, and the reload it fell back to could come up ineligible for live updates. An update that adds clips now waits for that layout pass, which costs nothing when the last pass is older than a third of a second and up to a third of a second in a burst.

## Paused title edits

The paused timing operation also carries existing Cutroom titles' validated attributes and plain text. It confirms the saved revision after seeking and painting, as timing does. Source and dependency revisions, parent-held eligibility and the live DOM comparison still gate it. [The architecture](architecture.md#cutrooms-own-editor) describes the title contract and reload rules.

The title budget uses browser Enter to confirmed picture while toggling inspector Size between 64 and 96 pixels on a visible title, five samples per path after 4.5 seconds of warm-up. Each sample checks saved and computed size, changed PNG and expected document retention or replacement. The interview parks at frame 90; the 500-clip workload parks at frame zero with no title entrance. The interview repeats #117's ten linked picture/sound cuts, four b-roll clips, music and four titles, using Cutroom titles.

Main `34ae629` reloads for title edits. Its normal approved path verifies the update before falling back. The PR's direct-reload control disables timing approval in the parent. Main and implementation ran separately on a loaded shared machine; their comparison is descriptive. The same-build relative comparison alternates live and direct reload within each pair and is the CI gate. The implementation includes main `5731b98`'s moved-playhead handoff fix; these measurements leave the playhead parked during the save.

| Workload                      | Main 34ae629 normal path |  PR live | PR direct reload | Live / reload |
| ----------------------------- | -----------------------: | -------: | ---------------: | ------------: |
| Interview with Cutroom titles |                 361.6 ms | 135.5 ms |         379.6 ms |         35.7% |
| 500 clips with Cutroom titles |               1,139.4 ms | 513.3 ms |       1,081.6 ms |         47.5% |

Both new cases require the live median below 80% of direct reload. The original visible 500-clip timing case keeps its limit and method. No existing budget changed. [Raw measurements](measurements/preview-title.json) retain every completed sample and outlier, earlier runs, validation and load snapshots. Local samples used one worker, Bun 1.4.4 and installed Chromium 155.0.8059.84, muted headless at 1720x1050 and DPR 1 with no renderer override. The owner was running a Rust build and browsers on the shared Intel Core i5-14400F with 32 GB RAM. These are loaded-machine measurements. The metric includes save, watcher, compilation, decoded hold and paint confirmation, not physical display scan-out.

For live-supported edits, byte-identical live/fresh PNG comparisons cover all inspector control families and None, Fade, Slide and Wipe at entrance, hold and exit frames, plus cut boundaries, multiline HTML-like words, fonts, plates, undo/redo and MCP edits in two tabs. Edits involving Scale reload because scaled font/motion and plate changes did not pass the pixel comparison. A fresh/fresh diagnostic also differed despite equal computed state and geometry. This does not relax any live-path PNG assertion. Scale regressions require canonical replacement for font, size, plate and words. Enabling motion without proven initial animation discovery also reloads.

The local full unit run passed 779 tests with five optional skips; the full functional run ran once with 445/448 passing. The scaled case became an explicit reload and the export/trim timeouts passed reruns. CI on `4599690` passed all 779 units, 449 functional tests and 11 performance cases before the final Scale restriction and main integration. On the integrated code, types, 56 focused units, 30 timing/title/gain workflows and both latency cases passed. The latest-main recheck passed 13 title/handoff workflows, including moved-playhead and playback continuity cases. The title/gain regression changes style, words, linked source timing and a fader in one operation, then retains the document for another title edit after a gain-only change. Final-head CI is linked in the PR.

## Range exports

A marked export mixes only the audio heard within a second of its range ([architecture](architecture.md#export-dialog)). Each case below exports two seconds (60 frames, Draft, 720p) through the editor's render route, one export at a time on a shared machine. The 500-clip project is `timelineWorkload(500)`: 240 linked picture and sound pairs over ten minutes. The interview project has ten linked interview cuts, b-roll, titles and a 60-second music bed. Planning is the time between the extraction and browser-start stages, where the mix runs beside plan hashing.

| Range                   | Main `f3ea6c9` total |  Main planning | Range mix total | Range mix planning |
| ----------------------- | -------------------: | -------------: | --------------: | -----------------: |
| 500 clips, 0:00 to 0:02 |               31.3 s |         19.0 s |  17.4 s, 15.1 s |       6.1 s, 5.6 s |
| 500 clips, 5:00 to 5:02 |       29.6 s, 28.4 s | 17.9 s, 17.2 s |  15.2 s, 15.4 s |       5.7 s, 5.7 s |
| Interview, 0:00 to 0:02 |         8.9 s, 8.1 s |   3.3 s, 3.3 s |    6.4 s, 7.6 s |       1.8 s, 2.2 s |
| Interview, 0:30 to 0:32 |         8.2 s, 8.2 s |   3.3 s, 3.3 s |    7.1 s, 7.6 s |       2.5 s, 2.6 s |

The interview's music bed starts at 0:00, so its 0:30 range still mixes 33 seconds of audio. A second main run of the 500-clip 0:00 case stalled at browser start, an intermittent stall that predates this change, and was cancelled. Forcing the full mix through the same pipeline gives byte-identical AAC packets for both the 500-clip 5:00 range and the interview 0:30 range. Against main, the decoded audio has zero lag, the same sample count and a 37 to 40 dB signal-to-difference ratio, which is main's second AAC encode.

## Exports from the source

An export whose every frame is one plain video clip draws from its sources with FFmpeg and starts no browser ([architecture](architecture.md#export-dialog)). Each case below exports through the editor's export route at Standard quality, one export at a time on a machine shared with other agents, alternating main `f2452ea` and the direct path on the same projects. Main's frame cache was warm, so its figures are its faster repeat-export case. Peak memory is the summed PSS of the export's processes; CPU is their total CPU time.

The interview is 45 seconds at 1080p30: ten linked BT.709 interview cuts with a frame counter burned in, three picture-only b-roll clips on V2 (one 720p, one 23.976 fps), a music bed at -12 dB and two titles. The 300-clip project is `timelineWorkload(300)` on a 720p copy of the interview: 140 linked pairs and 20 titles over 5:50. The plain project is the same layout with 150 pairs and no titles, 6:15 long.

| Export                               |      Main time |    Direct time | Main peak memory | Direct peak memory |   Main CPU | Direct CPU |
| ------------------------------------ | -------------: | -------------: | ---------------: | -----------------: | ---------: | ---------: |
| Interview, 5 s (0:05 to 0:10)        | 12.7 s, 13.6 s |   2.1 s, 2.1 s |           4.5 GB |             1.0 GB | 36 to 55 s |       11 s |
| 300 clips, 5 s (0:05 to 0:10)        | 21.5 s, 19.1 s |   1.8 s, 1.7 s |    9.6 to 9.9 GB |             1.0 GB | 62 to 94 s |       10 s |
| Plain, 5 s (0:05 to 0:10)            | 20.9 s, 19.2 s |   1.8 s, 1.7 s |  10.4 to 10.6 GB |             1.0 GB | 52 to 94 s |       10 s |
| Plain, 30 s (0:05 to 0:35)           |         51.2 s |          5.6 s |          10.6 GB |             2.8 GB |      181 s |       59 s |
| Plain, whole 6:15                    |        471.5 s | 62.1 s, 62.1 s |           9.2 GB |             3.7 GB |     2508 s |      792 s |
| Interview, 30 s (both capture)       |         34.1 s |         41.4 s |          11.4 GB |            11.3 GB |      177 s |      223 s |
| Interview, whole 0:45 (both capture) |         42.0 s |         40.6 s |          10.3 GB |            10.3 GB |      238 s |      186 s |
| 300 clips, 30 s (both capture)       |         50.0 s |         53.1 s |           9.2 GB |             9.8 GB |      188 s |      246 s |

The interview's 30-second range and whole timeline, and the 300-clip project's 30-second range, include b-roll or titles, so both builds capture them in the browser; their times moved with the machine's load (its load average reached 35 during these runs), not the code.

A first export of the interview's 5-second range on main, before its frame cache held those frames, took 16.5 s. Against main's exports, the direct ones show the same source frame in every frame (read from the burned-in counter) of all five direct exports above, including the 11,250 frames of the whole plain timeline, with mean differences of 0.9 to 1.5/255 and no more than 0.32/255 bias per channel. Range exports carry sample-identical sound; the whole timeline has the same 18,000,000 samples at 67 dB SNR, the difference of the two paths' AAC encodes. Compared with the decoded source frames of the interview range, the direct frames measure 47 to 48.5 dB PSNR and main's 34 to 34.6 dB: frame capture reads each frame through a JPEG extraction and a JPEG screenshot.

### Mixed exports

When only some runs need the browser, the source runs encode while HyperFrames plans and captures the rest. Same projects and conditions as above; main's figures are from the table above and a run of the 300-clip whole timeline.

| Export                         |           Main |            Mixed | Peak memory, main / mixed |      Captured runs |
| ------------------------------ | -------------: | ---------------: | ------------------------: | -----------------: |
| Interview, 30 s (0:05 to 0:35) | 34.1 s, 41.4 s |           15.4 s |             11.4 / 6.1 GB |                  1 |
| Interview, whole 0:45          | 42.0 s, 40.6 s |           25.0 s |             10.3 / 6.0 GB |                  2 |
| 300 clips, 30 s (0:05 to 0:35) | 50.0 s, 53.1 s |           21.4 s |              9.8 / 9.9 GB |                  1 |
| 300 clips, whole 5:50          |        612.2 s | captured as main |                    8.9 GB | 20, over the limit |

Each output shows the same source frame as main's in every frame, with sample-identical sound for ranges and 49.6 dB SNR for the whole interview (the two AAC encodes). About 8 s of each mixed export is HyperFrames planning and frame extraction, and each captured run then spent 6 to 7 s starting browsers, so these exports allowed at most three captured runs. Before that limit, the 300-clip whole timeline captured its first seven runs at about 13 s each, then one browser start stalled until Cutroom's 150-second start-up limit failed the export.

### One capture for every run

Every captured run of an export now shares one start of its capture browsers, sized to the frames they capture, so the run limit is gone. These fixtures rebuild the layouts above (interview: ten linked 1080p BT.709 cuts with a burned-in frame counter, three b-roll clips including a 720p and a 23.976 fps one, a music bed and two titles; 300 clips: `timelineWorkload(300)` on a 720p copy with 20 titles), exported whole at Standard quality through the export route, one at a time on a shared machine. Peak memory is the summed PSS of the export's processes.

| Export                | Main `ca73ce9`                 | One capture            | Peak memory, main / one capture | Free at start |
| --------------------- | ------------------------------ | ---------------------- | ------------------------------- | ------------: |
| Interview, whole 0:45 | 27.6 s, 24.3 s (2 starts)      | 18.2 s, 19.1 s, 18.8 s | 6.2 to 7.2 / 7.0 GB             |  19 to 22 GiB |
| 300 clips, whole 5:50 | 456.7 s (every frame captured) | 161.7 s, 2 browsers    | 9.2 / 13.1 GB                   |      22.6 GiB |
| 300 clips, whole 5:50 |                                | 222.8 s, 1 browser     | 8.0 GB                          |      19.5 GiB |

On the 300-clip timeline the shared capture holds 9.2 GB of Chromium with two browsers and 4.2 GB with one; the source parts' four FFmpeg encoders beside it hold 3.0 to 3.6 GB, which the browser plan now reserves, so with 19.5 GiB free it starts one browser instead of two. Against main, every one of the 10,500 frames shows the same source frame, with a mean difference of 0.97/255 (1.33 at worst) and at most 0.29/255 bias per channel, and the sound has the same 16,800,000 samples at 48.1 dB SNR, the two paths' AAC encodes. The interview's output is identical to main's. No browser start stalled in any of these exports.

### Placed clips and stills

Clips the inspector moved, scaled, rotated, cropped or faded, and image stills, now draw from their sources too ([architecture](architecture.md#export-dialog)). The workload is the interview above with five cuts edited (punch-ins at 115 to 125%, three of them moved, and one cut at 60%, turned 4 degrees and moved, over the page colour), a 1080p PNG slide and a 4:3 JPEG photo over cuts, b-roll, the music bed and two titles, exported whole at Standard quality.

| Export                       | Before (one capture) | Placed from source | Peak memory, before / after |
| ---------------------------- | -------------------: | -----------------: | --------------------------: |
| Edited interview, whole 0:45 |       37.4 s, 38.6 s |     25.8 s, 27.6 s |                9.7 / 8.1 GB |

The photo is letterboxed over an interview cut that shows around it, so it stays in the browser and the server log says why; the titles do too. Against the capture, the frames have a mean difference of 0.40/255 (1.14 at worst) and at most 0.82/255 bias, with sample-identical sound. Every frame whose counter is visible reads the same source frame; in the two punch-ins without an upward move the counter is scaled off the frame, and each of those 266 frames is closer to the capture's same frame (at most 1.14/255) than to either neighbour.

### GPU encoding

An export drawn wholly from its sources encodes with NVENC when the server's probe finds it working ([architecture](architecture.md#export-dialog)). On November 15, 2026, each case below exported through the export route at Standard quality, alternating main `f736424` and this change on an RTX 5060 (driver 615.78) and an Intel Core i5-14400F shared with other agents, so both columns carry the same load. The fixtures are noisier than the ones above, with light film grain over moving test patterns, which costs libx264 more: the interview is 45 seconds of ten linked 1080p30 BT.709 cuts, three b-roll clips (one 720p, one 23.976 fps), a music bed and two titles; the plain project is 150 linked cuts of a 720p copy, 6:15 long; the 300-clip project is the same with 140 pairs and 20 titles. Quality is measured against the same export at CRF 0, which is lossless, over every frame.

| Export                        |        Main time |       GPU time |     Main CPU |    GPU CPU |    Peak memory, main / GPU | Size, main / GPU | PSNR, main / GPU | VMAF, main / GPU |
| ----------------------------- | ---------------: | -------------: | -----------: | ---------: | -------------------------: | ---------------: | ---------------: | ---------------: |
| Interview, 5 s (0:05 to 0:10) |     5.3 s, 4.5 s |   2.6 s, 2.1 s |     31, 33 s |     7, 8 s |               1.1 / 0.5 GB |    10.5 / 8.4 MB |   47.4 / 47.8 dB |    99.88 / 99.90 |
| Plain, 30 s (0:05 to 0:35)    |   18.2 s, 26.5 s |   6.3 s, 6.7 s |   127, 132 s |   16, 16 s |               2.8 / 1.3 GB |   39.8 / 42.1 MB |   50.0 / 50.7 dB |    99.57 / 99.77 |
| Plain, whole 6:15             | 243.9 s, 238.4 s | 53.0 s, 57.4 s | 1613, 1604 s | 176, 180 s | 3.7 to 3.8 / 1.7 to 1.8 GB |     498 / 527 MB |                  |                  |

The first GPU export after the server starts includes the 0.4 s probe. Mixed exports keep libx264 for their source parts, because they join HyperFrames' libx264 captured parts: the interview's 30-second range and whole timeline and the 300-clip project's 30-second range produced bit-identical video on both builds (55.8 and 48.1 s, 52.2 and 59.3 s, 37.9 and 35.0 s, moving with the machine's load). The 300-clip whole timeline took 371 s on this change; main's run was refused by the memory check with 11.4 GB free, and its video is the same by the same reasoning.

NVENC's settings for each tier were chosen against libx264's on four 10-second clips: a vertical 1080x1920 camera clip and a 1080p camera clip, both from DNxHR masters, a 1080p screen recording, and 1080p test patterns under film grain. Each was encoded from a lossless copy with the direct path's settings (one closed GOP, no B-frames) and compared with that copy over every frame. The target was NVENC at or above libx264's PSNR and VMAF at a similar size; the table shows the settings that met it.

| Tier, clip                |           libx264 |     NVENC | Size, libx264 / NVENC | PSNR, libx264 / NVENC | VMAF, libx264 / NVENC |
| ------------------------- | ----------------: | --------: | --------------------: | --------------------: | --------------------: |
| Standard, vertical camera |    medium, CRF 18 | p5, CQ 23 |        14.1 / 13.9 MB |      48.58 / 49.30 dB |         96.81 / 97.67 |
| Standard, camera          |    medium, CRF 18 | p5, CQ 23 |          3.3 / 3.7 MB |      49.01 / 49.34 dB |         96.40 / 96.87 |
| Standard, screen          |    medium, CRF 18 | p5, CQ 23 |        0.15 / 0.17 MB |      52.36 / 52.11 dB |         97.27 / 97.18 |
| Standard, grain           |    medium, CRF 18 | p5, CQ 23 |        31.5 / 14.7 MB |      40.32 / 40.23 dB |         98.70 / 98.99 |
| High, vertical camera     |      fast, CRF 15 | p5, CQ 20 |        22.0 / 20.2 MB |      49.91 / 50.28 dB |         98.10 / 98.36 |
| High, camera              |      fast, CRF 15 | p5, CQ 20 |          4.8 / 6.0 MB |      49.65 / 49.91 dB |         97.10 / 97.39 |
| High, screen              |      fast, CRF 15 | p5, CQ 20 |        0.17 / 0.20 MB |      52.46 / 52.54 dB |         97.32 / 97.31 |
| High, grain               |      fast, CRF 15 | p5, CQ 20 |       116.9 / 20.2 MB |      41.85 / 40.28 dB |         98.79 / 99.20 |
| Draft, vertical camera    | ultrafast, CRF 28 | p3, CQ 30 |          5.2 / 4.9 MB |      43.17 / 46.47 dB |         86.41 / 93.75 |
| Draft, camera             | ultrafast, CRF 28 | p3, CQ 30 |          2.4 / 1.5 MB |      43.71 / 47.22 dB |         90.07 / 94.06 |
| Draft, screen             | ultrafast, CRF 28 | p3, CQ 30 |        0.14 / 0.12 MB |      50.21 / 51.39 dB |         95.88 / 96.74 |
| Draft, grain              | ultrafast, CRF 28 | p3, CQ 30 |          7.6 / 7.6 MB |      37.83 / 39.22 dB |         94.04 / 97.02 |

The screen recording is the one clip where Standard NVENC trails, by 0.25 dB and 0.09 VMAF, at a 160 KB file. NVENC keeps to the H.264 level it signals, 4.0 at 1080p30, so grain at High stops near 16 Mbit/s, where libx264 writes 93 Mbit/s under the same level; its PSNR is 1.6 dB lower there and its VMAF higher. Spatial and temporal AQ, P7 and P6 lowered PSNR and VMAF or cost time without a gain. Encoding the camera clip took NVENC 1.4 s of wall time against libx264's 5.6 s, most of NVENC's CPU being the decoder. Comparing frames with different colour tags makes FFmpeg convert one side first, which cost 16 dB on these measurements before both sides were tagged alike.

### Formats, sizes and rates

MOV, WebM, GIF, another size and another frame rate are captured in the browser ([architecture](architecture.md#export-dialog)). On November 16, 2026, each case below exported the whole of a five-second 1080p30 composition, a title over a 640 x 360 picture-in-picture video, at Standard quality through the render workers, one at a time on a machine shared with other agents (13 to 14 GiB free). Two browsers captured each export. Peak memory is the summed PSS of the export's processes.

| Export                |   Time | Peak memory |    Size |
| --------------------- | -----: | ----------: | ------: |
| MP4, 1080p, 30 fps    |  8.4 s |     2.57 GB |  0.7 MB |
| MP4, 1080p, 24 fps    |  6.5 s |     2.57 GB |  0.6 MB |
| MP4, 4K               | 12.8 s |     4.31 GB |  3.1 MB |
| MOV (ProRes 4444)     | 11.0 s |     1.89 GB | 30.0 MB |
| MOV (ProRes 4444), 4K | 26.2 s |     4.29 GB | 83.1 MB |
| WebM (VP9 with alpha) | 11.1 s |     1.92 GB |  0.5 MB |
| GIF                   | 15.8 s |     1.93 GB |  5.4 MB |

Transparent formats capture PNG screenshots instead of JPEG, and GIF adds a ProRes render and its own encode, which accounts for their extra time. At 4K the peak is FFmpeg's encoder rather than the browsers: two-second ranges with one browser peaked with the encoder at 2.25 GB for libx264, 2.77 GB for VP9 and 4.02 GB for ProRes (also 4.02 GB for a GIF, which encodes ProRes first), against 1.05 GB for ProRes at 1080p and a 1080p H.264 encoder too small to show beside a 1.03 GB browser. The memory plan reserves that encoder by megapixel.

Encode on the GPU, on a 20-second 1080p30 clip under film grain drawn wholly from its source (RTX 5060): 3.8 s and 3.8 s with NVENC (43.1 MB), 22.4 s and 24.5 s with libx264 (410.5 MB, which keeps grain at CRF 18; see [GPU encoding](#gpu-encoding) for quality at each tier).

## Scrubbing

A ruler drag asks for a new frame on every pointer move. [Scrub proxies](architecture.md#scrub-proxies) answer those seeks from an all-intra 540-line copy of each video and show the exact frame once the pointer rests. On November 15, 2026 the same drag ran against `main` and this change: 3 s across 900 px of ruler at Fit, about 60 pointer moves a second, headless installed Chromium 155 at 1720x1050, alternating the two builds. A CDP screencast recorded every composited frame, and each frame's number was read back from blocks burned into the footage, so a picture counts only when the viewer showed a new source frame. The interview is a 90 s 1080p30 H.264 file (8 Mbit/s, 1 s GOP) with a title; the 300-clip timeline is `timelineWorkload` over a 720p copy, with each 2.5 s clip its own element.

| Three runs each                          | Interview, `main` |      Interview, proxies | 300 clips, `main` | 300 clips, proxies |
| ---------------------------------------- | ----------------: | ----------------------: | ----------------: | -----------------: |
| New pictures per second while dragging   |                 0 |              41, 51, 52 |       0, 0.3, 0.3 |      8.7, 9.3, 9.3 |
| Pointer to picture, median / worst       |      only at rest |           26-29 / 47 ms |      only at rest |   128-145 / 197 ms |
| Pictures of a frame the playhead skipped |                 0 |                       0 |                 0 |                  0 |
| Browser CPU while dragging, cores        |              4.85 |                    3.83 |               3.9 |                4.4 |
| Exact frame after a single move          |             65 ms | 150 ms (proxy at 23 ms) |                 – |                  – |

CPU was measured with the screencast off. The 300-clip timeline uses more CPU because it now loads and draws each clip it passes; it is bounded by those loads, not by decoding. A single move shows the exact frame later than before, since the source decodes only after 60 ms of rest; the proxy frame at Fit is close to the viewer's own resolution.

## Footage pipeline

The [footage pipeline](architecture.md#footage-pipeline) is a setting, off by default. On November 15, 2026 both settings ran on the same production build of this change, alternating, on a private server: installed Chromium 155 at 1720x1050 on the RTX 5060 (ANGLE Vulkan), muted, with the machine shared with other work and DaVinci Resolve holding 4.5 of the GPU's 8 GB. Every source frame carries its number in 16 blocks along the top, and a picture counts only when a screencast frame shows a new number. The interview is `interviewWorkload` with a 60 s 1080p30 file at 8 Mbit/s and a 1 s GOP: ten cuts that each jump back a second in one file, four b-roll clips from a 720p file over them, music and four titles. The 400-clip timeline is `timelineWorkload(400)` over a 720p30 copy with a 1 s GOP: 190 linked 2.5 s cuts and 20 titles. Playback was measured headed (headless halves the clock with this much media), with `requestVideoFrameCallback` in the preview for HyperFrames and the pipeline canvas's draws for the pipeline; HyperFrames' count includes both pictures where b-roll overlaps the interview. Its gaps are the callbacks' times, which can land a display frame early or late of the picture itself (see [Cutroom vs HyperFrames Studio](#cutroom-vs-hyperframes-studio)), so they can overstate HyperFrames' gap p95.

| Ranges over 2 runs                                   |     Interview, off |      Interview, on |       400 clips, off |      400 clips, on |
| ---------------------------------------------------- | -----------------: | -----------------: | -------------------: | -----------------: |
| New pictures per second while dragging the ruler     |          28.1-28.4 |          28.5-29.0 |              8.6-8.7 |          29.0-29.5 |
| Playhead positions per second in the same drag       |          29.3-29.4 |          29.2-29.7 |            22.8-25.0 |          29.0-29.8 |
| Pointer to picture, median / worst                   | 50-52 / 327-329 ms | 32-33 / 348-351 ms | 149-150 / 312-335 ms | 31-32 / 370-371 ms |
| W, key to final picture                              |         476-529 ms |          63-104 ms |          955-1347 ms |         144-230 ms |
| Undo of W                                            |         403-431 ms |           69-78 ms |           858-926 ms |         129-138 ms |
| X (lift)                                             |           60-86 ms |           32-35 ms |           231-381 ms |           32-35 ms |
| Undo of lift                                         |           78-85 ms |           53-54 ms |           206-211 ms |           84-87 ms |
| Frame step, median / p95 (30 steps, 0 wrong frames)  |         63 / 79 ms |         40 / 95 ms |           64 / 75 ms |         26 / 70 ms |
| J (reverse 1x): new pictures per second, gap p95/max |     29.9, 51/59 ms |     29.5, 38/70 ms |       29.2, 59/85 ms |     29.6, 37/39 ms |
| L L (2x): new pictures per second, gap p95/max       |     30.9, 66/69 ms |     46.1, 34/40 ms |       26.0, 68/87 ms |     56.3, 30/38 ms |
| 1x playback, headed: pictures per second             |          28.4-41.5 |          28.7-30.0 |            29.8-29.9 |               30.0 |
| 1x playback, headed: gap p95 / max                   |   38-55 / 54-77 ms |  39-41 / 86-201 ms |     40-42 / 56-67 ms |      39 / 44-46 ms |

Every picture shown while dragging was a frame the playhead visited, and the resting frame was exact in every run. The worst pointer-to-picture time in each run is the first picture of the drag. With the pipeline on, every playhead position the drag produced got a picture; the drag itself delivered about 29 positions a second in this harness, so that is the ceiling here, not the pipeline (a draw took 12 ms at the median).

### Memory

Measured again after #189 on the same 8 s drag across the whole 400-clip timeline at Fit, as the proportional set size (PSS) of every renderer process, with the browser launched and driven over a bare DevTools connection (Runtime and Input only). Playwright's Network domain makes the renderer keep fetched response bodies, which added up to about 200 MB to the pipeline's process, so Playwright runs overstate it. Installed Chromium 155 launched directly (the `/usr/bin/chromium` wrapper loads the user's extensions), and the Electron 45 desktop app (`dist-desktop/main.cjs`) with its own data directory, on a shared machine.

| Renderers after the drag (PSS) |                    Chromium |                 Electron 45 |
| ------------------------------ | --------------------------: | --------------------------: |
| Pipeline off                   |                      878 MB |                      931 MB |
| Pipeline on, browser converts  | 915-928 MB (editor 687-689) | 900-914 MB (editor 706-714) |
| Pipeline on, YUV planes        | 431-443 MB (editor 186-187) | 414-453 MB (editor 202-235) |

A Chromium memory dump of the editor's process before the change put 508 MB in `cc/image_memory`, the canvas image cache that `texImage2D(VideoFrame)` fills, against 99 MB in the decoders' frame pools. Skipping the upload alone took the process from 874 MB to 381 MB. Copying a frame's planes out took 0.2 ms at the median and 0.9 ms at worst during 1x playback of the 400-clip timeline.

The first measurement, below, read resident memory through Playwright, so its numbers are not comparable with these.

After an 8 s drag across the whole 400-clip timeline at Fit, the browser's renderer processes held 3,286 MB with the pipeline off (the preview's process 3,081 MB, with 103 video and 103 audio elements loaded) and 958 MB with it on (the preview's process 169 MB with no video and one audio element loaded; the editor's process 733 MB, of which decoded frames are at most 192 MB; the rest was later traced to the canvas image cache, above, not the decoders).

The shortfalls above (W on the 400-clip timeline, and stalls where b-roll stops covering the interview) are measured again below.

### Playback and edits

On November 16, 2026, against #189 and later, with the same workloads, the bare DevTools driver from Memory above, and headed windows (X11, so a window the desktop does not show still paints). Installed Chromium 155 and the Electron 45 desktop app, each against the same private server, on a shared machine (load average 2 to 26 during the runs). Main's pipeline is the build before the lookahead and decoder changes. Playback starts at 5 s and runs 46 s on the interview and 20 s on the 400-clip timeline; a picture is a canvas draw with a new frame. W and undo are timed from the key to the first canvas draw whose burned-in number is the expected frame, at four playheads per timeline.

| Ranges                                     |       Chromium, main |       Chromium, now |                   Electron, main | Electron, now |
| ------------------------------------------ | -------------------: | ------------------: | -------------------------------: | ------------: |
| Interview 1x: pictures per second          |            16.1-29.5 |           29.4-29.9 |                        24.0-29.4 |     29.4-29.7 |
| Interview 1x: gap p95 / max                | 49-274 / 200-1342 ms |   35-38 / 67-160 ms |                49-66 / 94-983 ms |    35 / 83 ms |
| 400 clips 1x: pictures per second, max gap | 29.2-29.4, 68-118 ms | 29.3-29.5, 67-68 ms |             29.0-29.9, 69-103 ms |   29.3, 68 ms |
| W, interview                               |             39-75 ms |             9-19 ms |                         35-77 ms |      10-18 ms |
| W, 400 clips                               |           103-227 ms |            27-32 ms |                        55-158 ms |      21-27 ms |
| Undo of W, interview                       |             41-61 ms |            26-33 ms | 41-61 ms, one 1059 ms, one never |      25-34 ms |
| Undo of W, 400 clips                       |            90-144 ms |            75-88 ms |                        83-105 ms |      65-93 ms |

HyperFrames' own playback of the interview, headed in Chromium through Playwright on the same machine, gave 36.9-37.1 pictures per second (both pictures where b-roll overlaps the interview count), gap p95 40-53 ms and max 130-167 ms. Two frames at 30 fps is 67 ms.

What changed: lookahead prepares every clip that comes into view, including one a clip above stops covering, and at rest the next clip to come into view, so W finds its frame decoded. Main's stalls came mostly from its decoders: the frames a decoder kept centred on the furthest frame playback had asked for and never moved back, so after playback restarted earlier in a file each new frame was evicted as it arrived, and a frame the decoder wrongly took to be in flight was waited for by feeding the rest of the file (8.3 s once). After undo, most of the remaining time is the editor's: its timeline view arrives 20-26 ms after the key on the interview and 63-137 ms on the 400-clip timeline, and the pipeline draws 17-43 ms after that.

### Real footage

On November 16, 2026, the pipeline was checked against HyperFrames on camera, phone and screen footage: the owner's own recordings (a DaVinci Resolve 1080p60 MOV render with a timecode track, a vertical Resolve MOV, a full-range MP4 with an ICC profile, a 60 fps screen recording at 1916x1074, an OBS HEVC recording), and ffmpeg stand-ins with numbered frames for what was missing. Parity is the e2e test's comparison, the viewer with and without the pipeline at nine frames across two cuts, headless; the export tolerance is a mean difference under 4/255 and a bias under 1.5/255. Playback, scrub, steps and edits were measured headed in Chromium 155 through Playwright (X11), on a four-cut 1080p composition of one file, with renderer memory as the proportional set size after a drag (Playwright's Network domain inflates the pipeline's side, as above).

| Footage                                          | Drawn by                                             | Parity, mean / worst bias | 1x playback on: pictures/s, gap p95/max | Off          | Step, median / p95 | W / undo   |
| ------------------------------------------------ | ---------------------------------------------------- | ------------------------: | --------------------------------------: | ------------ | -----------------: | ---------- |
| H.264 4K60, 40 Mbit/s, 2 s GOP                   | pipeline                                             |                 2.7 / 0.3 |                         43.1, 66/260 ms | 49.8, 34/84  |        18 / 227 ms | 13 / 27 ms |
| H.264 1080p30, 4 s GOP with B-frames             | pipeline                                             |                 2.0 / 0.3 |                          30.0, 34/94 ms | 30.0, 50/84  |          7 / 82 ms | 10 / 19 ms |
| Phone portrait, 90° matrix (also 180°, 270°)     | pipeline                                             |                 0.6 / 0.2 |                          29.3, 50/66 ms | 29.9, 50/83  |          9 / 33 ms | 31 / 18 ms |
| Variable frame rate, 1/60 and 1/20 s frames      | pipeline                                             |                 2.0 / 0.3 |                          30.0, 35/50 ms | 21.4, 83/100 |          8 / 31 ms | 13 / 25 ms |
| Resolve 1080p60 MOV (real)                       | pipeline                                             |                 2.4 / 0.3 |                          60.2, 18/18 ms | 51.2, 34/84  |          7 / 10 ms | 12 / 18 ms |
| Resolve vertical MOV (real), open GOP            | pipeline                                             |                 0.6 / 0.4 |                          30.2, 34/35 ms | 29.8, 50/84  |         7 / 102 ms | 11 / 18 ms |
| Screen recording, 60 fps, 1916x1074 (real)       | pipeline                                             |                 1.4 / 0.2 |                          58.3, 18/34 ms | 49.3, 34/84  |          7 / 79 ms | 10 / 18 ms |
| Full range: ICC (real), bitstream tags, EBU colr | pipeline (EBU through the browser)                   |                 0.9 / 0.4 |                                       - | -            |                  - | -          |
| H.264 High 10, SDR                               | pipeline, through the browser                        |                 0.2 / 0.1 |                                       - | -            |                  - | -          |
| Trimmed MP4 (edit list into a GOP), audio first  | pipeline                                             |                 0.4 / 0.1 |                                       - | -            |                  - | -          |
| HDR: HLG or PQ in MP4 `nclx`, MOV `nclc`, VUI    | HyperFrames, "Wide-gamut and HDR video"              |                         - |                                       - | -            |                  - | -          |
| Delayed start (empty edit)                       | HyperFrames, "edit list delays"                      |                         - |                                       - | -            |                  - | -          |
| HEVC 8 and 10-bit (stand-ins, OBS recording)     | pipeline, from its [editing proxy](#editing-proxies) |                         - |                                       - | -            |                  - | -          |
| Fragmented MP4, audio-only file, MKV             | HyperFrames                                          |                         - |                                       - | -            |                  - | -          |

Chromium 155 and Electron 45 on Linux decode no HEVC, in `<video>` or WebCodecs, so HEVC showed no picture with or without the pipeline until [editing proxies](#editing-proxies). Moving the ruler, the pipeline drew 57 to 60 new pictures a second of the 60 positions the pointer gave it, for every kind. Memory after the drag was 1,460 MB with the pipeline and 2,000 MB without on 4K60; on the 1080p files of one source it was 20 to 80 MB higher with the pipeline, which only saves memory once many clips would each load a `<video>`.

Before the fixes measured here, rotated phone video drew sideways (mean difference 121 to 218), HDR in a MOV and HDR named only in the bitstream drew untone-mapped (bias 26 and 18), Android's full-range EBU footage drew 8/255 too little blue, a delayed edit list drew the wrong frames, and Resolve's MOVs, which write negative composition offsets in a version 0 `ctts`, showed the previous frame for one in two or three frames, then stalled on the open GOP's B-frames once their times were read right. 4K60 played at 2.3 pictures a second: low-latency decoding ran at 94 fps there against 166 with frame threading, and the two lanes fell behind each other. On the 400-clip timeline, frame threading measured the same as low latency (29.6 pictures a second, steps 31 / 54-104 ms against 29-31 / 105-107 ms, W 39 ms, undo 96-102 against 100-165 ms).

In that comparison the 4K60 decoders produced about four frames for each one drawn. Cutroom now leaves sources above the 1080p pixel budget with HyperFrames, clip by clip. At an x264 open GOP's leading B-frames, a seeking `<video>` shows the keyframe after them and the pipeline shows the frame the file's timestamps name, as the export does; the e2e test checks those frames by number.

## Editing proxies

Measured on November 16, 2026, on the owner's machine (16 threads, RTX 5060, FFmpeg 9.0), through the media service's own job, from ffmpeg stand-ins with grain at OBS-like settings (x265, a keyframe every 2 s, two B-frames, BT.709, AAC). CPU is the job's processes' user time.

| Source, one minute                             | NVENC: time, CPU | libx264: time, CPU | Proxy, NVENC / libx264 |
| ---------------------------------------------- | ---------------: | -----------------: | ---------------------: |
| HEVC 1080p30, 8-bit, 12 Mbit/s                 |      4.0 s, 15 s |       10.5 s, 58 s |         90 MB / 113 MB |
| HEVC 2160p30, 10-bit, 40 Mbit/s, made at 1080p |     12.0 s, 73 s |      14.1 s, 116 s |          71 MB / 57 MB |

Decoding 4K HEVC is most of the work: NVDEC saved 3 s of the 16 a minute took before the decoder's threads went from four to six, so decoding stays on the CPU, where every frame takes the same path as the export's. Eight threads made it 10.8 s at 5.5 cores. CQ 21 made 115 MB a minute at 4K for no picture the viewer can show; CQ 25 is about libx264's CRF 20.

Every frame's burned-in number and presentation time matched the source's in the proxy: HEVC 1080p and 4K, 8 and 10-bit, variable frame rate, NTSC HEVC in Matroska (on the source's millisecond clock; FFmpeg's default had snapped it to 1001/30000 steps, up to 0.4 ms off), ProRes 422 at 23.976 and DNxHR at 29.97. Exports of the same timelines carried every frame's number too, since they read the source.

Colour, Chrome drawing the proxy against FFmpeg's decode of the export at three frames: 8-bit 1080p HEVC differs by 3.6/255 on average with at most 0.4/255 bias, within the export suite's 4 and 1.5. 10-bit 4K differs by 4.3/255 with up to 2.5/255 bias: an 8-bit copy of a 10-bit picture alone measures 0.7/255 more red, even encoded losslessly with any dither, and Chrome's drawing of a downscaled picture adds about one more.

Before and after, on a fresh project of one 10 s HEVC 1080p30 clip, headed in Chromium 155 (X11):

|                      | Before                                  |             After, HyperFrames |                 After, pipeline |
| -------------------- | --------------------------------------- | -----------------------------: | ------------------------------: |
| Picture              | never; "did not draw the frame in time" |            4.9 s after opening |                           2.9 s |
| 1x playback, 3 s     | no picture                              | 88 of 90 frames, all different | 83 pictures sampled every 10 ms |
| Step, median / max   | -                                       |                     31 / 33 ms |                       4 / 16 ms |
| Ruler drag, 61 moves | no picture                              |           63 stand-in pictures |                     61 pictures |

A minute of 4K 10-bit HEVC shows "Preparing footage" 1.7 s after opening and its picture after 17 s. Before one editing proxy could run beside a filmstrip, the same clip waited 28 s for its filmstrip first.

On one of the owner's OBS recordings (HEVC Main, 1080p60, 17.4 minutes, in Matroska, checked locally and deleted), NVENC made the proxy in 93 s (5.4 s a minute, 25 MB a minute) and libx264 in 140 s (19 MB a minute). All 62,509 frame times matched the recording's, and sampled frames differed from it by 0.2/255 on average. In the editor the clip played 86 pictures in 3 s through the pipeline, with 30 ms steps.

### Long recordings, piece by piece

The whole file used to be made before the clip played, so that recording showed "Preparing footage" for 95 s. Now the proxy is made in pieces of about four seconds that play as each is made, the piece under the playhead first. Measured on November 16, 2026, headed in Chromium 155 (Wayland), on a fresh project of one clip, the playhead moved with the timecode entry once the viewer reported ready. Two clips: a 15-minute HEVC 1080p60 stand-in (NVENC, a keyframe every 4.2 s, two B-frames, millisecond times in Matroska, a frame number in blocks along its top, read off the viewer), and the 17.4-minute recording above. Scrub proxies and filmstrips were made alongside, as in use.

| 15-minute stand-in, footage pipeline off        |               Before |                                             After |
| ----------------------------------------------- | -------------------: | ------------------------------------------------: |
| "Preparing footage" on screen                   |               83.7 s |                                             2.7 s |
| Viewer ready                                    |                6.1 s |                                             4.0 s |
| Exact frame at 10:00, after moving there        |               76.9 s |                                             1.2 s |
| Playing on from 10:00, 3 s                      |           after 77 s | at once: frames 36,000 to 36,181, each sample new |
| Exact frame after moving to 3:20, 14:00, 7:30.5 | after the whole file |                                   1.3, 1.1, 1.2 s |
| Proxy finished                                  |                 87 s |                                              89 s |

With the footage pipeline on, the same steps took 3.7 s to ready, 1.3 s to the frame at 10:00 and 1.2 s for each move; HyperFrames draws the clip from its pieces until the proxy is finished, then the pipeline draws it. On the recording, the viewer was ready in 4.0 s against 6.0 s, the picture at 10:00 came 1.3 s after moving there against 91 s, each far move took 1.2 to 1.5 s, and the proxy was finished at 102 s against 101 s. All 62,509 of its frame times matched the recording's again, and frames on both sides of a cut differed from the recording by 0.17 to 0.21/255.

A piece of 1080p60 takes 0.35 s with NVENC once a run has started; starting a run costs about 0.5 s more, most of it NVENC's, plus decoding from the source's keyframe before the cut. Planning reads only the packets: 0.3 s for the recording. One run makes pieces as fast as the whole-file encode did (10.6 s against 10.9 s for two minutes), and joining them into the finished file took 3 s for 15 minutes.

While the proxy is made, its pieces take as much disk as the finished file will; the finished file is written beside them and they are removed 30 s later, so for a moment a recording's proxy takes twice its size.

Once it has jumped to a later piece, Chromium's HLS player shows the frame nearest a paused seek, where an MP4 shows the frame at or before it. The viewer seeks a quarter of a frame into each frame, where both show it; see Frames on a millisecond clock, below.

## Frames on a millisecond clock

On November 16, 2026, a 60 fps timeline over 60 fps recordings on Matroska's millisecond clock, as OBS writes them: half a second from 2 s in, stepped one frame at a time with the arrow key, each picture read by the number burned into it and compared with the frames an MP4 export of the same timeline wrote (`e2e/frame-rounding.spec.ts`, installed Chromium 155, headless).

| Frames matching export, of 30   | Before | After |
| ------------------------------- | -----: | ----: |
| HEVC, pipeline off (proxy)      |     15 |    30 |
| HEVC, pipeline on               |     20 |    30 |
| H.264 in Matroska, pipeline off |     15 |    30 |

Before, a step left the previous picture up at every other frame (HyperFrames' runtime does not move a paused video for less than 20 ms, and a 60 fps frame is 16.7 ms), and the pipeline and the finished proxy showed the frame before wherever the millisecond clock rounded a frame's start up. A wider matrix through the viewer, against direct exports, matched at every frame after the change: 30 and 29.97 fps sources on 60 and 30 fps timelines, 59.94 fps on 60 (where the two grids drift apart) and on 59.94, 60 fps on 30, a clip starting at 7.123 s, MP4 sources on a millisecond clock through the pipeline, and frames 24,000 to 24,011 of a seven-minute HEVC recording while its proxy was still in pieces, with the pipeline off and on.

## Footage lookahead during frame steps

Measured November 17, 2026 against `fba38c8b`, production builds in headless Chromium 155 on Linux, footage pipeline explicitly enabled. Each 400/500-clip workload uses `scripts/timeline-performance.ts`: linked cuts from one 60-second 640 × 360 H.264/AAC source and 20 titles in a 1080p30 composition. The source carries a binary frame number along its top. The viewer was ready and its media warmed before 16 forward and 16 reverse arrow-key steps, 125 ms apart, from timeline frame 3000. Three runs of each build and size were interleaved, with the final pair reversed. Browser and media workloads ran one at a time.

| Median across three runs                                |   Before |    After |
| ------------------------------------------------------- | -------: | -------: |
| 400 clips, one lookahead query                          |   2.7 ms |   0.2 ms |
| 500 clips, one lookahead query                          |   3.7 ms |   0.2 ms |
| 400 clips, all 32 queries                               |  90.6 ms |   6.0 ms |
| 500 clips, all 32 queries                               | 128.2 ms |   6.4 ms |
| 400 clips, main-thread task time during the interaction | 797.7 ms | 720.1 ms |
| 500 clips, main-thread task time during the interaction | 863.6 ms | 744.0 ms |

Temporary `performance.measure` calls included query setup and result construction; they were removed after measurement. Main-thread time is CDP `TaskDuration`, sampled around the complete interaction and its 700 ms settling period. Lookahead prepares one document-order map, disabled-track set and list of video intervals for its inclusive window instead of rebuilding them at every frame. Ownership and transition partners still inspect the whole timeline, and transition/covering calculations still run frame by frame. There is no retained query cache.

The CPU reduction did not establish a general picture-latency improvement. Median first-picture latency in the three 400-clip runs ranged 37.7 to 42.7 ms before and 36.5 to 42.4 ms after; at 500 clips it ranged 40.2 to 43.9 ms before and 41.0 to 42.6 ms after. Pictures were read from composited screencasts after measurement, using the burned-in frame numbers rather than the canvas's requested-frame attribute. Every one of the 384 steps showed the expected source picture before the next input. Two additional matched 500-clip runs in each build crossed a cut in both directions from timeline frame 3070; all 128 pictures also matched. No long tasks occurred in these runs. Cold project opening was 1.4 to 2.0 seconds across both builds; that fixture warms filmstrips and peaks first, so it is not a cold-media benchmark.

This improves synchronous lookahead work when the experimental footage pipeline is on. It does not establish a playback-rate or memory improvement, and does not change the setting's default, classification, decoders, clock or HyperFrames confirmation. To reproduce the interaction manually, enable the footage pipeline, open the same generated workload, type `00:01:40:00`, and alternate 16 Right and 16 Left inputs at eight inputs per second. The cut-crossing variant starts at `00:01:42:10`.

## Clip versions

Switching a clip's versions in the viewer posts one message to the shown document, which toggles which version's host is marked shown and answers after its next frame. The time is from the pointer entering a row in the versions list to that answer, on November 18, 2026, with four GSAP scene versions of one title, Chromium 155 on the shared Intel Core i5-14400F with 32 GB RAM:

| Run                                   | Hover to picture, each switch |
| ------------------------------------- | ----------------------------: |
| Headed, hardware GPU                  |               15.3 to 19.7 ms |
| Headless, software compositing        |               35.5 to 38.6 ms |
| Headless e2e (`e2e/versions.spec.ts`) |               25.7 to 36.8 ms |

Headed, that is the one frame the document needs to draw at 60 Hz. Hovering the version already shown sends nothing.

Only one clip's versions are loaded at a time, and a clip holds at most 12, so the extra work is bounded by one clip's scenes, never the project's length. With the list open on that title, Chromium's processes held 1,204 MB against 1,130 MB before it opened (four scenes, three of them standing by), and the next document without them gives that back. The active version is the compiled one, so the viewer's picture with the list open matched the picture without it byte for byte in the e2e test.

### Footage and audio versions

The open list warms the shown take and the next playable row. Native preview parks the other media elements and drops their sources. GPU playback shares the footage pipeline's sample indices, frame grids and compressed-byte caches. It keeps a short decoder window for each of the two takes, borrowing the main decoder for the take that was already shown. An existing scrub proxy can show a frame while a cold take decodes. Closing the list releases the audition decoders and the alternate source caches the timeline no longer uses. Sound stays in the preview's existing audio graph, with a 10 ms gain ramp between takes. Media versions do not warm just because a clip is selected.

Nine localhost `setVersion` requests over the timeline command endpoint took 34.1 to 89.6 ms, with a 43.2 ms median. Each request saved the picture and its linked sound in one history step. This measurement ends at the server response.

The first browser pass used headless Chromium 155 at 1720 × 1050 and four playable 1080p takes, including two In points from the same source file. A fifth take was too short and skipped warming. The timings start at the pointer event and end at the first Chromium screencast frame whose picture has the selected take's colour. PSS is the sum across Chromium processes.

| Playback | Hover median |    Hover range | PSS before opening | PSS with list open |
| -------- | -----------: | -------------: | -----------------: | -----------------: |
| Native   |      53.9 ms |   33.9–71.1 ms |            747 MiB |          1,124 MiB |
| GPU      |     128.1 ms | 111.3–310.4 ms |            793 MiB |          1,506 MiB |

The headed retest after limiting residency used the same single-slot fixture at 1720 × 1050. Each mode exercised nine hovers and three clicks without first hovering the target. Memory is Chromium PSS in MiB before opening the list, while comparing a take, and 300 ms after the version preview was replaced.

| Playback | Hover median (range) | Click median (range) | PSS before / open / closed |
| -------- | -------------------: | -------------------: | -------------------------: |
| Native   | 33.4 ms (31.6–128.1) |  24.8 ms (22.0–32.2) |            692 / 799 / 787 |
| GPU      |  22.5 ms (16.5–62.7) | 39.3 ms (27.6–127.9) |            788 / 998 / 950 |

The headed results exceed the 15–20 ms hover target. Jumping past the next playable row can require opening and seeking a new decoder. A click at a paused position outside the warmed frames can require decoding from a keyframe. A stand-in depends on the scrub proxy already being available, and the measurement includes Chromium compositing the resulting picture.

Set `CUTROOM_VERSION_EVIDENCE` to a scratch directory to record timings from `e2e/media-versions.spec.ts`. With `CUTROOM_VERSION_SCALE=100`, the fixture has 100 cuts, ten with four 1080p versions each. The test explicitly exercises native and GPU footage playback and records the first displayed frame of each alternate.

The 100-cut headed comparison used `e95f5eba` as the baseline. The menu was open on the first clip while playing an alternate. PSS is in MiB. The closed figure was sampled 300 ms after the audition preview was replaced.

| Playback | PSS before / open / closed, baseline | PSS before / open / closed, bounded | List overhead, baseline → bounded | Hover median, baseline → bounded |
| -------- | -----------------------------------: | ----------------------------------: | --------------------------------: | -------------------------------: |
| Native   |                    834 / 1,012 / 895 |                     796 / 888 / 852 |                      178 → 92 MiB |                   35.7 → 43.9 ms |
| GPU      |                1,070 / 1,431 / 1,302 |               1,018 / 1,272 / 1,277 |                     361 → 254 MiB |                   29.7 → 39.8 ms |

Browser PSS includes Chromium's playback and compositor allocations. The GPU run still held 1,277 MiB at the closed sample. The bounded build releases its audition decoders on close, and this measurement does not establish when Chromium returns the remaining memory to the OS.
