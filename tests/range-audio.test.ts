import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAudioElements } from "@hyperframes/engine";
import type { AudioElement } from "@hyperframes/engine";
import { rangeMix } from "../src/server/hyperframes/rangeAudio";
import type { Fps } from "../src/shared/timeline/schema";

import { applyAll } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  parseComposition,
  patchComposition,
} from "../src/server/timeline/composition";
import { countingIds } from "./clip-ids";
const ntsc = { num: 30000, den: 1001 };
const seconds = (frame: number, fps: Fps = ntsc) =>
  Number(((frame * fps.den) / fps.num).toFixed(6));

// A 20 second timeline with an NTSC cut, fractional starts, and an authored bus.
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
  const worker = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `import { registerRenderIsolation } from ${JSON.stringify(import.meta.resolve("../src/server/hyperframes/renderIsolation.ts"))};
     import { join } from "node:path";
     registerRenderIsolation();
     const { processCompositionAudio } = await import("@hyperframes/engine");
     const [dir, name, pcm, duration, audios] = JSON.parse(process.argv[1]);
     const result = await processCompositionAudio(audios, dir, join(dir, name + "-work"),
       join(dir, name + ".m4a"), duration, undefined, { keepEncoderInputAt: pcm });
     if (!result.success || result.failures?.length) throw new Error(JSON.stringify(result));`,
      JSON.stringify([dir, name, pcm, duration, audios]),
    ],
    { stderr: "pipe", stdout: "ignore" },
  );
  const [error, exit] = await Promise.all([
    new Response(worker.stderr).text(),
    worker.exited,
  ]);
  expect(exit, error).toBe(0);
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
  expect(mix.startSeconds).toBe(2);
  expect(mix.durationSeconds).toBeCloseTo(seconds(360) + 1 - 2, 9);

  const quiet = rangeMix({
    audios: elements(),
    durationSeconds: 20,
    startSeconds: 15.2,
    endSeconds: 15.9,
  });
  expect(quiet.audios).toEqual([]);
  expect(quiet.startSeconds).toBe(14);
});

test.skipIf(!Bun.which("ffmpeg"))(
  "a mixer cut at a fractional frame boundary places adjacent clips on adjacent samples",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "sample-grid-"));
    try {
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=0.08+0.03*sin(2*PI*439*t)|0.1+0.03*sin(2*PI*631*t):s=48000:d=5",
        "-c:a",
        "pcm_s16le",
        join(dir, "tone.wav"),
      ]);
      const start = seconds(2);
      const end = seconds(120);
      const group =
        '<hf-audio-group id="bus" data-volume="0.5"></hf-audio-group>';
      const tag = (id: string, from: number, to: number, mediaStart = 0) =>
        `<audio id="${id}" src="tone.wav" data-audio-group="bus" data-start="${from}" data-end="${to}" data-media-start="${mediaStart}"></audio>`;
      const whole = await mixed(
        dir,
        "whole",
        parseAudioElements(group + tag("whole", start, end)),
        end,
      );
      for (const frame of [61, 62]) {
        const cut = seconds(frame);
        const mediaStart =
          (Math.round(cut * 48000) - Math.round(start * 48000)) / 48000;
        const split = await mixed(
          dir,
          `split-${frame}`,
          parseAudioElements(
            group +
              tag("left", start, cut) +
              tag("right", cut, end, mediaStart),
          ),
          end,
        );
        expect(
          Buffer.from(split.buffer).equals(Buffer.from(whole.buffer)),
        ).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

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

test.skipIf(!Bun.which("ffmpeg"))(
  "saved half-sample ramp cuts keep the same PCM through the full and marked mixer",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ramp-absolute-audio-"));
    const audio = (fps: Fps, start: number, duration: number) =>
      `<main data-composition-id="main" data-duration="12" data-fps="${fps.num}/${fps.den}">
      <audio id="ramp" src="tone.wav" data-start="${start}" data-duration="${duration}" data-media-start="0.5"
        data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":0.25,"curve":1},{"t":6,"v":4}]}]}'></audio></main>`;
    const edit = (html: string, input: CommandInput) => {
      const parsed = parseComposition(html, emptyTimelineSettings());
      const origins = new Map<string, ClipOrigin>();
      const changed = applyAll(parsed.timeline, [CommandSchema.parse(input)], {
        newId: countingIds,
        onCreate: (id, origin) => origins.set(id, origin),
      });
      return patchComposition(parsed, changed, origins);
    };
    try {
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=0.12*sin(2*PI*440*t)|0.12*sin(2*PI*331*t)+0.12*sin(2*PI*2273*t):s=48000:d=12",
        "-c:a",
        "pcm_s16le",
        join(dir, "tone.wav"),
      ]);
      const bytes = (sum: Float32Array) => Buffer.from(sum.buffer);
      for (const fps of [ntsc, { num: 24000, den: 1001 }]) {
        const original = audio(fps, 600.5 / 48000, 6);
        const split = edit(original, {
          type: "split",
          clipIds: ["ramp"],
          at: 62,
        });
        const full = await mixed(
          dir,
          `before-${fps.num}`,
          parseAudioElements(original),
          12,
        );
        const kept = await mixed(
          dir,
          `split-${fps.num}`,
          parseAudioElements(split),
          12,
        );
        expect(bytes(kept).equals(bytes(full))).toBe(true);
      }
      const html = audio(ntsc, 5.01253125, 6);
      const audios = parseAudioElements(
        edit(html, { type: "trim", clipId: "ramp", edge: "start", to: 213 }),
      );
      const full = await mixed(dir, "whole", audios, 12);
      const startSeconds = (228 * 1001) / 30000;
      const endSeconds = (243 * 1001) / 30000;
      const window = rangeMix({
        audios,
        durationSeconds: 12,
        startSeconds,
        endSeconds,
      });
      expect(window.startSeconds).toBeGreaterThan(0);
      const marked = await mixed(
        dir,
        "marked",
        window.audios,
        window.durationSeconds,
      );
      const left = Math.round(startSeconds * 48000);
      const right = Math.round(endSeconds * 48000);
      const shift = window.startSeconds * 48000;
      expect(
        bytes(marked)
          .subarray((left - shift) * 8, (right - shift) * 8)
          .equals(bytes(full).subarray(left * 8, right * 8)),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  45_000,
);
