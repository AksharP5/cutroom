# Audio clip finish evidence

Baseline: d315fb5. Final implementation based on 9a9538c, including #49 and #50.

`before.png` and `after.png` use the same project, time, selected audio clip, 1720x1050 CSS-pixel viewport, and dark theme. The project has three video tracks and two audio tracks. Media is generated locally: speech-shaped harmonic audio peaking at -3.5 dB, a chord bed, and H.264/AAC video with sound. Waveforms show source peaks, as before.

`before-clip.png` and `after-clip.png` are matching audio-clip crops. `held-roll.png` and `gain-readout.png` come from the browser regression covering a held roll and a gain drag on the bottom track.

The 500-clip browser workload follows docs/performance.md: 240 linked picture and sound pieces plus 20 titles, 600 seconds at 30 fps, referencing a generated 720-second H.264/AAC file. The source is a static picture with speech-shaped sound. Both builds share the warm media cache. Chromium uses hardware ANGLE on an NVIDIA GeForce RTX 5060, with audio muted, at 1720x1050. A page callback sends one Ctrl+wheel event per animation frame for 910 frames, sweeping fit to 32 px/frame and back. Scrolling then runs at 2 px/frame, 8 px per animation frame, for 900 frames. Each case runs twice per build. Intervals use performance.now() at callback entry, include late frames, and do not use a profiler. Other work shares the machine.

`before-fps.json` and `final-fps.json` contain the raw run summaries. `fps.png` plots their means and run ranges. Final zoom is 59.5–59.7 fps and scroll is 59.5–60.0 fps. The run summaries report callback p95 and late frames; these are not claims of perfect 60 fps pacing.
