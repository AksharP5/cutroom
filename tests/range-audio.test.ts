import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAudioElements,
  processCompositionAudio,
} from "@hyperframes/engine";
import type { AudioElement } from "@hyperframes/engine";
import { rangeMix } from "../src/server/hyperframes/rangeAudio";
import type { Fps } from "../src/shared/timeline/schema";

const ntsc = { num: 30000, den: 1001 };
const seconds = (frame: number, fps: Fps = ntsc) =>
  Number(((frame * fps.den) / fps.num).toFixed(6));

// A 20 second timeline shaped like a Cutroom edit. The A-roll cut (frame 315)
// and the loop (frame 285) start half a millisecond off the mixer's
// millisecond grid at 29.97. Moved 2 s earlier, the loop's start rounds to the
// other millisecond.
const composition = `<main data-composition-id="main" data-duration="20" data-fps="30000/1001">
<hf-audio-group id="track-2" data-cutroom-track="2" data-volume="0.5"></hf-audio-group>
<video id="a1" class="clip" src="aroll.mp4" data-has-audio="true" data-start="${seconds(225)}" data-duration="${seconds(90)}" data-media-start="0.3" data-fade-out="0.4"></video>
<video id="a2" class="clip" src="aroll.mp4" data-has-audio="true" data-start="${seconds(315)}" data-duration="${seconds(85)}" data-media-start="${(0.3 + seconds(90)).toFixed(6)}"></video>
<audio id="far" src="music.m4a" data-start="1" data-duration="2"></audio>
<audio id="bed" src="music.m4a" data-start="2" data-duration="12" data-media-start="1.25" data-audio-group="track-2" data-automation='{"version":1,"lanes":[{"target":"volume","points":[{"t":0,"v":0.2},{"t":8.4,"v":1,"curve":1},{"t":12,"v":0.4}]}]}'></audio>
<audio id="fast" src="music.m4a" data-start="${seconds(330)}" data-duration="3" data-media-start="0.5" data-playback-rate="1.5" data-fade-in="0.25"></audio>
<audio id="blip" src="blip.wav" data-start="${seconds(285)}" data-duration="2" loop data-audio-group="track-2"></audio>
<audio id="late" src="music.m4a" data-start="17" data-duration="2"></audio>
</main>`;

function elements(): AudioElement[] {
  return parseAudioElements(composition).map((audio) =>
    // Browser discovery attaches GSAP volume tweens in composition time.
    audio.id === "blip"
      ? {
          ...audio,
          volumeKeyframes: [
            { time: 10.2, volume: 1 },
            { time: 11, volume: 0.2 },
          ],
        }
      : audio,
  );
}

async function ffmpeg(args: string[]) {
  const child = Bun.spawn(["ffmpeg", "-v", "error", "-nostdin", ...args], {
    stderr: "pipe",
  });
  const [error, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
}

/** The float sum the mixer encodes, interleaved stereo at 48 kHz. */
async function mixed(
  dir: string,
  name: string,
  audios: AudioElement[],
  duration: number,
) {
  const pcm = join(dir, `${name}.wav`);
  const result = await processCompositionAudio(
    audios,
    dir,
    join(dir, `${name}-work`),
    join(dir, `${name}.m4a`),
    duration,
    undefined,
    { keepEncoderInputAt: pcm },
  );
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  const bytes = await readFile(pcm);
  const data = bytes.indexOf("data", 12);
  const size = bytes.readUInt32LE(data + 4);
  return new Float32Array(
    bytes.buffer.slice(
      bytes.byteOffset + data + 8,
      bytes.byteOffset + data + 8 + size,
    ),
  );
}

test("a range's mix covers only what is heard there, whole seconds earlier", () => {
  const mix = rangeMix({
    audios: elements(),
    durationSeconds: 20,
    startSeconds: seconds(300),
    endSeconds: seconds(360),
  });
  expect(mix.audios.map((audio) => audio.id)).toEqual([
    "bed",
    "fast",
    "blip",
    "a1-audio",
    "a2-audio",
  ]);
  expect(mix.startSeconds).toBe(1);
  expect(mix.durationSeconds).toBeCloseTo(seconds(360) + 1 - 1, 9);

  const quiet = rangeMix({
    audios: elements(),
    durationSeconds: 20,
    startSeconds: 15.2,
    endSeconds: 15.9,
  });
  expect(quiet.audios).toEqual([]);
  expect(quiet.startSeconds).toBe(14);
});

test("bus effects and group automation read the whole timeline, so they mix in full", () => {
  const audios = elements();
  const range = { durationSeconds: 20, startSeconds: 10, endSeconds: 12 };
  const full = { startSeconds: 0, durationSeconds: 20, audios };
  const chain = '{"version":1,"nodes":[]}';
  expect(rangeMix({ ...range, audios, masterFxChain: chain })).toEqual(full);
  for (const group of [{ groupFxChain: chain }, { groupAutomation: chain }]) {
    const grouped = audios.map((audio) =>
      audio.groupId ? { ...audio, ...group } : audio,
    );
    expect(rangeMix({ ...range, audios: grouped }).audios).toBe(grouped);
  }
});

test.skipIf(!Bun.which("ffmpeg"))(
  "a range mixes the same samples as the full mix, across offsets, cuts, rate, fades, gain, groups and loops",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "range-audio-"));
    try {
      await ffmpeg([
        ...["-f", "lavfi", "-i", "testsrc2=size=64x48:rate=30:duration=8"],
        ...[
          "-f",
          "lavfi",
          "-i",
          "aevalsrc=0.3*sin(2*PI*(220*t+40*t*t))|0.25*sin(2*PI*(310*t+25*t*t)):s=48000:d=8",
        ],
        ...["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"],
        ...["-shortest", join(dir, "aroll.mp4")],
      ]);
      await ffmpeg([
        ...[
          "-f",
          "lavfi",
          "-i",
          "aevalsrc=0.3*sin(2*PI*330*t)*(1+0.5*sin(2*PI*0.7*t))|0.3*sin(2*PI*495*t+1):s=44100:d=16",
        ],
        ...["-c:a", "aac", join(dir, "music.m4a")],
      ]);
      await ffmpeg([
        ...[
          "-f",
          "lavfi",
          "-i",
          "aevalsrc=0.4*sin(2*PI*880*t)*exp(-3*t):s=48000:d=0.7",
        ],
        join(dir, "blip.wav"),
      ]);
      const full = await mixed(dir, "full", elements(), 20);
      for (const [fps, start, end] of [
        [ntsc, 300, 360],
        [{ num: 30, den: 1 }, 300, 360],
        [ntsc, 0, 45],
        [ntsc, 560, 599],
      ] as const) {
        const { num, den } = fps;
        const mix = rangeMix({
          audios: elements(),
          durationSeconds: 20,
          startSeconds: (start * den) / num,
          endSeconds: (end * den) / num,
        });
        const window = await mixed(
          dir,
          `range-${num}-${start}`,
          mix.audios,
          mix.durationSeconds,
        );
        const sample = (frame: number) =>
          Math.round((frame * den * 48000) / num);
        const from = sample(start) * 2;
        const to = sample(end) * 2;
        const offset = mix.startSeconds * 48000 * 2;
        let difference = 0;
        let power = 0;
        for (let i = from; i < to; i++) {
          difference = Math.max(
            difference,
            Math.abs(window[i - offset]! - full[i]!),
          );
          power += full[i]! ** 2;
        }
        expect({ start, end, num, difference }).toEqual({
          start,
          end,
          num,
          difference: 0,
        });
        // Silence on both sides would pass the comparison trivially.
        if (start !== 560) expect(power / (to - from)).toBeGreaterThan(1e-3);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
