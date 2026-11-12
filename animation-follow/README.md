# Animation left behind after Shift+X

Same absolute-hard fixture, 1720 × 1050 viewport, CTA selected at 00:00:18:08 after ripple-deleting Shot B with Shift+X. The clip moved from 36 s to 18 s; its helper-authored GSAP tween stayed at 36 s.

- `before.png`: origin/main, no warning. The title is invisible.
- `after.png`: animation-follow, header warning and Timing attention text. Ask agent saves a Review note at the title's first frame.

The picture stays broken in this PR. Retiming the tween is the next step; this PR detects and reports the mismatch.
