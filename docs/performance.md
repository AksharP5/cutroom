# Performance checks

Run the production UI benchmark with `bun run build && bun run bench:ui`. To compare a portable release, pass `--app /path/to/release/resources/app --output artifacts/baseline.json`. `CUTROOM_BENCH_PORT` selects an unused loopback port.

The benchmark creates synthetic local media and a project with 100 clips, 10,000 transcript words, and 200 chat messages. It uses three fresh browser contexts, consumes the rendered results, and checks that all 10,000 words can be selected. Native agent discovery is stubbed; inference speed is outside this measurement.

The November 9, 2026 local comparison used Bun 1.4.4, system Chromium, the portable 0.1.0 build, and the 0.1.1 production build. These are local measurements, not a comparison with proprietary HyperFrames Studio.

| Operation                                      |           0.1.0 |     0.1.1 |
| ---------------------------------------------- | --------------: | --------: |
| Editor and conversation ready, median          |        1,095 ms |    882 ms |
| Notebook data before opening Script, first run | 2,925,817 bytes | 116 bytes |
| Saved note visible, median                     |          418 ms |    192 ms |
| 1,000 drawing events handled, median           |         55.3 ms |   18.5 ms |
| Drawing backing-store resizes                  |           2,000 |         2 |
| Open 10,000-word script, median                |          526 ms |    544 ms |
| Select 10,000 words, median                    |          664 ms |    605 ms |
| Composer input to two animation frames, p95    |         34.8 ms |   36.7 ms |

The composer result does not show a reliable improvement. Browser-driver typing duration is not treated as input latency. Drawing is a synthetic burst intended to expose repeated canvas allocation, not a claim about physical pointer sampling rates.

The editor bundle contains one CodeMirror View instance instead of eight. The editor JavaScript fell from 6,176,227 to 5,110,878 bytes, and from 1,848,339 to 1,501,949 bytes with gzip. It retains the pinned upstream editor version and source-editing functionality.

`bun run bench:transcripts` measures transcript listing separately. Reusing one parsed source per request reduced the 100-clip, 5,000-word workload from about 154 ms to 7 ms warm. The request still reads current source files; this does not rely on a cross-request cache.
