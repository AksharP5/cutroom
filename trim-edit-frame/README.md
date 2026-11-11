# Trim edit frame evidence

Design checkpoint 5, issue 2. The viewer used to stay on the playhead while trimming.

Both captures use the same generated 640x360, 30 fps testsrc2 video with a burnt-in frame number, timecode, and ten binary frame bits. The outgoing clip starts at source 2 seconds; the incoming clip starts at source 10 seconds. The playhead is parked at timeline frame 30, which shows source frame 90.

Each sequence holds the pointer down and moves the edge by 6, 12, 18, and 24 frames. Trim out moves left; trim in and roll move right. Screenshots 1 through 4 are mid-drag. Before images use main at 26d541bf9704c0d854d4ca1f62d48c0b53c13fe5.

| Operation | Before, all four steps | After, steps 1 through 4 |
| --- | --- | --- |
| Trim in | 90 | 306, 312, 318, 324 |
| Trim out | 90 | 173, 167, 161, 155 |
| Roll | 90 | 185 / 306, 191 / 312, 197 / 318, 203 / 324 |

The e2e test decodes the burnt-in binary pixels from the captured video canvas at every step, checks that the same iframe remains live during the drag, and checks source frame 90 after both Escape and release. Release also waits for the persisted clip duration and confirmed replacement document. Separate cases cover ripple-in, ripple-out, audio-only, and trimming a linked picture through its audio partner.

The performance test uses 400 real-media clips, all mounted at Fit, with 540 pointer updates across 180 animation frames. It measures bridge requests and replies, the maximum pending seek count, and display-frame intervals. Raw samples are in perf/.

After images and final drag timings use `f62cf2956693f902d659d9ad9c48594b8ff84c18`. The functional suite covers all 193 cases; one existing scrolling request-count timing failure passed on its isolated retry. The final seven trim cases pass. All four performance tests pass.
