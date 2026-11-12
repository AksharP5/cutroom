# Tween retiming

The CTA starts at 36 seconds in the source fixture. W ripple ending Shot B at 18:11 moves it to 24:11.

Both editor captures park at 24:19 with a 1720×1050 viewport. `before-editor.png` renders the source written by main's timeline engine at 3ae36b1. `after-editor.png` renders the same source with the CTA tween position changed from 36 to 24.366667. Playwright separately verifies the fixed command route and exact undo/redo bytes.

`after-export.png` is frame eight of the draft MP4 range exported through Cutroom's own export route after the real W edit. The title's opacity in the editor is 0.7822 at that frame. The exported frame shows the same title, position and fade.

Benchmark JSON records serial measurements before the full suites. The same 500-clip fixture and 37,855-byte script were measured with main's engine and the retimer. The existing 50 ms end-to-end request ceiling fails slightly on both versions; the new animated move and ripple patch ceilings pass.
