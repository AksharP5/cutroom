# Mix evidence

Before: main at 790099a. After: mix-basics.

The screenshots use the same eight-second speech and music project, dark theme, and viewport sizes 1720x1050 and 1440x900. The music gain was dragged to -12 dB and its fade-out to 120 frames at 30 fps. The speech fixture is the local ALSA Front_Center.wav sample, looped for the playback check. Music is a generated chord. The WebM has no audio stream.

A separate stereo reference-tone cut keeps the channels independent for measurement. Voice is +6 dB on the left; music is -12 dB on the right with the same 120-frame fade-out. levels.json contains the runtime level tap and FFmpeg-decoded export peaks at three playback times. Export samples cover the 50 ms preceding the measured runtime time, matching the tap's analyser window. Each channel must agree within 1 dB.

playback.json records displayed-frame intervals during three seconds of actual playback with both meters active. Both requested viewports ran at 60 fps with no intervals over 25 ms. The meter WebM shows a separate playback of the speech and music cut.
