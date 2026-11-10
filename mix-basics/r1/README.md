# R1 fade fixes

An eight-second 220 Hz tone has a four-second fade-out and is split at four seconds. Render both the whole and edited HTML with HyperFrames `parseAudioElements` and `processCompositionAudio`. Decode AAC to 48 kHz float PCM with FFmpeg and compare peaks in 20 ms windows centered on each time. Negative values mean the split is quieter than the whole clip.

| Time | Before, split minus whole | After, split minus whole |
| --- | ---: | ---: |
| 2.00 s | -5.98 dB | 0.00 dB |
| 3.95 s | -36.81 dB | 0.00 dB |
| 4.05 s | +0.004 dB | 0.00 dB |

The raw measurements also cover splits at 1, 4 and 6 seconds with a two-second fade-in and six-second fade-out. Those 24 sample windows differ by less than 0.003 dB after the fix. The committed regression also covers authored curved volume automation, with a 1 dB acceptance limit.

The screenshots show the actual 1720x1050 browser workflow after mixing, after E at four seconds, and after W to two seconds followed by another fade drag. Media was muted during capture.
