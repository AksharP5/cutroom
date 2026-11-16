import { loudness, silence } from "@hyperframes/core/audio-analysis";
import {
  MAX_AUTOMATION_POINTS,
  VOLUME_TARGET,
  parseAutomation,
  sampleAutomationLane,
} from "@hyperframes/core/audio-automation";
import {
  MAX_AUDIO_GAIN,
  audioDbToGain,
  audioGainToDb,
} from "@hyperframes/core/audio-gain";
import { z } from "zod";
import type { Project } from "../../shared/project";
import { HttpError } from "../../shared/errors";
import { localMediaPath } from "../../shared/media";
import { frameTime } from "../../shared/timeline/apply";
import { clipName } from "../../shared/timeline/labels";
import { volumePoints } from "../../shared/timeline/mix";
import type {
  Clip,
  CommandInput,
  Timeline,
} from "../../shared/timeline/schema";
import { localMediaInputOptions } from "../media/input";
import { projectPath } from "../projects/path";

/** Speech is found at this rate; a word needs no more to be told from a pause. */
const ANALYSIS_RATE = 16_000;

const clipId = z.string().min(1).max(200);

export const DuckRequestSchema = z.object({
  bed: clipId.describe("The clip to duck, such as a music bed"),
  voices: z
    .array(clipId)
    .min(1)
    .max(64)
    .optional()
    .describe(
      "The voice clips to duck under. Omit to use every other clip with sound that plays over the bed and is not named like music or effects",
    ),
  depth: z
    .number()
    .min(-40)
    .max(-1)
    .default(-12)
    .describe("How far the bed comes down under the voice, in dB"),
  attack: z
    .number()
    .min(0)
    .max(2)
    .default(0.25)
    .describe("Seconds the bed takes to come down, ending as the voice starts"),
  release: z
    .number()
    .min(0)
    .max(5)
    .default(0.6)
    .describe("Seconds the bed takes to come back up after the voice stops"),
});
export type DuckRequest = z.infer<typeof DuckRequestSchema>;

export const LoudnessRequestSchema = z.object({
  clipIds: z.array(clipId).min(1).max(64),
  target: z
    .number()
    .min(-40)
    .max(-5)
    .default(-16)
    .describe("Integrated loudness to reach, in LUFS"),
});

const ffmpeg = () => {
  const path = Bun.which("ffmpeg");
  if (!path)
    throw new HttpError(503, "FFmpeg is needed to measure audio. Install it.");
  return path;
};

/** The project file a clip plays, which must exist inside the project. */
async function sourceOf(project: Project, composition: string, clip: Clip) {
  const path = clip.src && localMediaPath(composition, clip.src);
  if (!path || clip.mediaStart === null)
    throw new HttpError(422, `${clipName(clip)} has no file in the project.`);
  return projectPath(project, path);
}

/** What a clip plays of its file: from its source offset for its length, at its speed. */
function window(clip: Clip, fps: Timeline["fps"]) {
  const seconds = frameTime(clip.duration, fps) * clip.playbackRate;
  return ["-ss", String(clip.mediaStart ?? 0), "-t", String(seconds)];
}

async function run(args: string[], output: "stdout" | "stderr") {
  const child = Bun.spawn([ffmpeg(), ...args], {
    stdout: output === "stdout" ? "pipe" : "ignore",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    output === "stdout"
      ? new Response(child.stdout).arrayBuffer()
      : Promise.resolve(new ArrayBuffer(0)),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new HttpError(
      422,
      `FFmpeg could not read the audio: ${stderr.trim().split("\n").at(-1) ?? code}`,
    );
  return { stdout, stderr };
}

/**
 * A clip's sound as heard on the timeline, mono at the analysis rate. Paths and numbers are the
 * only things FFmpeg is given.
 */
async function decode(path: string, clip: Clip, fps: Timeline["fps"]) {
  if (clip.playbackRate < 0.5 || clip.playbackRate > 2)
    throw new HttpError(
      422,
      `${clipName(clip)} plays at ${clip.playbackRate}x; ducking reads voices from 0.5x to 2x.`,
    );
  const { stdout } = await run(
    [
      "-v",
      "error",
      ...window(clip, fps),
      ...localMediaInputOptions,
      "-i",
      path,
      "-vn",
      ...(clip.playbackRate === 1
        ? []
        : ["-af", `atempo=${clip.playbackRate}`]),
      "-ac",
      "1",
      "-ar",
      String(ANALYSIS_RATE),
      "-f",
      "f32le",
      "pipe:1",
    ],
    "stdout",
  );
  return new Float32Array(stdout);
}

/** Integrated loudness and true peak of a file, or of the part of it a clip plays. */
export async function measureLoudness(
  path: string,
  part?: { clip: Clip; fps: Timeline["fps"] },
) {
  const { stderr } = await run(
    [
      "-hide_banner",
      "-nostats",
      ...(part ? window(part.clip, part.fps) : []),
      ...localMediaInputOptions,
      "-i",
      path,
      "-vn",
      "-af",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ],
    "stderr",
  );
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const integrated = Number(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1]);
  const peak = Number(/Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1]);
  return {
    lufs: Number.isFinite(integrated) ? integrated : null,
    truePeak: Number.isFinite(peak) ? peak : null,
  };
}

/** Clip gain that moves a clip measured at `lufs` with `gain` to `target`, held at +12 dB. */
export function normalizedGain(lufs: number, gain: number, target: number) {
  const wanted = audioDbToGain(target - lufs) * gain;
  return Math.round(Math.min(MAX_AUDIO_GAIN, wanted) * 1e6) / 1e6;
}

/** Each clip's gain set so it measures `target` LUFS on its own, as one undo step. */
export async function loudnessPlan(
  project: Project,
  composition: string,
  timeline: Timeline,
  request: z.infer<typeof LoudnessRequestSchema>,
) {
  const clips = request.clipIds.map((id) => {
    const clip = timeline.clips.find((each) => each.id === id);
    if (!clip) throw new HttpError(404, `No clip ${id}.`);
    if (!clip.hasAudio)
      throw new HttpError(422, `${clipName(clip)} has no sound to measure.`);
    return clip;
  });
  const measured = await Promise.all(
    clips.map(async (clip) => {
      // Measured at the file's own level, so the clip's current gain does not matter.
      const { lufs, truePeak } = await measureLoudness(
        await sourceOf(project, composition, clip),
        { clip, fps: timeline.fps },
      );
      if (lufs === null)
        throw new HttpError(
          422,
          `${clipName(clip)} is too quiet to measure: it is silent under the meter's gate.`,
        );
      const volume = normalizedGain(lufs, 1, request.target);
      return {
        clipId: clip.id,
        measured: lufs,
        truePeak,
        volume,
        reaches:
          Math.round((lufs + audioGainToDb(volume)) * 10) / 10 ===
          request.target
            ? request.target
            : Math.round((lufs + audioGainToDb(volume)) * 10) / 10,
      };
    }),
  );
  return {
    label: `Normalize loudness to ${request.target} LUFS`,
    commands: measured.map(({ clipId, volume }): CommandInput => ({
      type: "setClip",
      clipId,
      volume: volume === 1 ? null : volume,
    })),
    clips: measured,
  };
}

/** Times the voice speaks, in its own seconds: everything but pauses a third of a second or longer. */
function speech(samples: Float32Array) {
  const signal = { sampleRate: ANALYSIS_RATE, channels: [samples] };
  const duration = samples.length / ANALYSIS_RATE;
  const level = loudness(signal).lufsIntegrated;
  if (level === null) return [];
  // A pause is well under the voice's own level, whatever level it was recorded at.
  const quiet = silence(signal, {
    thresholdDb: Math.max(-60, Math.min(-30, level - 20)),
    minMs: 300,
  });
  const spans: { start: number; end: number }[] = [];
  let from = 0;
  for (const pause of quiet) {
    if (pause.start > from) spans.push({ start: from, end: pause.start });
    from = pause.end;
  }
  if (from < duration) spans.push({ start: from, end: duration });
  return spans;
}

/**
 * Volume points that bring the bed down by `depth` while any voice speaks: down over `attack`
 * before speech, up over `release` after it. Pauses too short to come back up in stay down.
 * The duck multiplies the bed's own envelope, so its points and fades keep shaping it.
 */
export function duckPoints(
  bed: Clip,
  fps: Timeline["fps"],
  spans: readonly { start: number; end: number }[],
  { depth, attack, release }: Pick<DuckRequest, "depth" | "attack" | "release">,
) {
  const length = frameTime(bed.duration, fps);
  const merged: { start: number; end: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && span.start - last.end < attack + release)
      last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  if (!merged.length) return volumePoints(bed.automation, fps) ?? [];
  const floor = audioDbToGain(depth);
  const duck = (time: number) =>
    merged.reduce((level, { start, end }) => {
      if (time >= start && time <= end) return Math.min(level, floor);
      const ramp =
        time < start
          ? attack > 0 && start - time < attack
            ? (start - time) / attack
            : 1
          : release > 0 && time - end < release
            ? (time - end) / release
            : 1;
      return Math.min(level, floor + (1 - floor) * ramp);
    }, 1);
  const lane = bed.automation
    ? parseAutomation(bed.automation).lanes.find(
        (each) => each.target === VOLUME_TARGET,
      )
    : undefined;
  const own = (time: number) => (lane ? sampleAutomationLane(lane, time) : 1);
  const times = [
    ...new Set([
      ...merged.flatMap(({ start, end }) => [
        start - attack,
        start,
        end,
        end + release,
      ]),
      ...(lane?.points.map((point) => point.t) ?? []),
    ]),
  ]
    .filter((time) => time >= 0 && time <= length)
    .sort((a, b) => a - b);
  // A bed that starts mid-ramp needs its level at its first frame.
  const edges = [0, ...times, length].filter(
    (time, index, all) => all.indexOf(time) === index,
  );
  const points = edges.map((time) => ({
    frame: Math.round(((time * fps.num) / fps.den) * 1e3) / 1e3,
    gain: Math.round(own(time) * duck(time) * 1e6) / 1e6,
  }));
  // Neighbours at one level make a run; only its ends are needed.
  return points.filter(
    (point, index) =>
      index === 0 ||
      index === points.length - 1 ||
      point.gain !== points[index - 1]!.gain ||
      point.gain !== points[index + 1]!.gain,
  );
}

/** The voices a bed is ducked under: those named, or every other clip with sound over it that is not a bed. */
function voicesFor(timeline: Timeline, bed: Clip, request: DuckRequest) {
  const overlaps = (clip: Clip) =>
    clip.start < bed.start + bed.duration &&
    bed.start < clip.start + clip.duration;
  if (request.voices)
    return request.voices.map((id) => {
      const clip = timeline.clips.find((each) => each.id === id);
      if (!clip) throw new HttpError(404, `No clip ${id}.`);
      if (clip.id === bed.id)
        throw new HttpError(422, "A clip cannot duck under itself.");
      if (!clip.hasAudio)
        throw new HttpError(422, `${clipName(clip)} has no sound.`);
      return clip;
    });
  return timeline.clips.filter(
    (clip) =>
      clip.id !== bed.id &&
      clip.hasAudio &&
      clip.enabled &&
      clip.track !== bed.track &&
      overlaps(clip) &&
      !/music|bgm|bed|score|song|sfx|whoosh|ambien/i.test(
        `${clip.id} ${clip.label ?? ""} ${clip.src ?? ""}`,
      ),
  );
}

/** Volume points that duck a bed under its voices, measured from what they play. */
export async function duckPlan(
  project: Project,
  composition: string,
  timeline: Timeline,
  request: DuckRequest,
) {
  const bed = timeline.clips.find((clip) => clip.id === request.bed);
  if (!bed) throw new HttpError(404, `No clip ${request.bed}.`);
  if (!bed.hasAudio)
    throw new HttpError(422, `${clipName(bed)} has no sound to duck.`);
  const voices = voicesFor(timeline, bed, request);
  if (!voices.length)
    throw new HttpError(422, `No voice plays over ${clipName(bed)}.`);
  const { fps } = timeline;
  const spans = (
    await Promise.all(
      voices.map(async (voice) => {
        const samples = await decode(
          await sourceOf(project, composition, voice),
          voice,
          fps,
        );
        // On the bed's clock: the voice's own seconds from where it starts on the bed.
        const offset = frameTime(voice.start - bed.start, fps);
        return speech(samples).map(({ start, end }) => ({
          start: start + offset,
          end: end + offset,
        }));
      }),
    )
  ).flat();
  const volume = duckPoints(bed, fps, spans, request);
  if (volume.length > MAX_AUTOMATION_POINTS)
    throw new HttpError(
      422,
      `The duck needs ${volume.length} points, more than HyperFrames' ${MAX_AUTOMATION_POINTS}. Duck a shorter bed.`,
    );
  return {
    label: `Duck ${clipName(bed)} under the voice`,
    commands: [
      { type: "setClip", clipId: bed.id, automation: { volume } },
    ] satisfies CommandInput[],
    voices: voices.map((voice) => voice.id),
    speech: spans.length,
  };
}
