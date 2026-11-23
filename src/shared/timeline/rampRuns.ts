import { sourceTimeAt } from "@hyperframes/core/speed-ramp";
import type { HfAutomationPoint } from "@hyperframes/core/audio-automation";
import { AUDIO_SAMPLE_RATE, fraction, resolvePiece } from "./piece.ts";
import type { placedMedia } from "./placedMedia.ts";

/** A run starts on a block of 10 s, counted from the sample curve zero falls in. */
export const RUN_BLOCK_SAMPLES = 480_000;
/** A run file is made a whole second longer at a time, so a small extension needs no work. */
export const RUN_GRAIN_SAMPLES = 48_000;
/**
 * The last samples of a run file are the stretcher's flush, not what a longer run plays there.
 * A file covers its length less this margin, which exceeds the stretcher's output latency.
 */
export const RUN_MARGIN_SAMPLES = 4_800;
/** The most stereo 16-bit frames a WAV can hold. */
export const MAX_WAV_FRAMES = Math.floor((0xffffffff - 36) / 4);

/**
 * One continuous stretch of a ramp's sound from the start of its first block onward: everything
 * that decides its samples, and nothing about where it sits on the timeline or how far it goes,
 * so a moved ramp, an undo or a longer piece finds the same run. The stretcher is causal, so a
 * run made longer keeps every sample it already had.
 */
export type RampRun = {
  points: HfAutomationPoint[];
  /** Source microseconds at curve zero. */
  zero: number;
  /** How far curve zero lies past the sample it falls in, as an exact fraction of a sample. */
  phase: [numerator: string, denominator: string];
  /** The block the run starts on, counted from that sample. */
  first: number;
};

/**
 * The part of a run one piece plays: run samples `[from, to)`. `frames` is how far the run must
 * reach for every piece of the document that slices it.
 */
export type RunSlice = {
  run: RampRun;
  from: number;
  to: number;
  frames: number;
};

/** The length a run file is made to so that it covers `frames`. */
export const runBuildFrames = (frames: number) =>
  Math.ceil((frames + RUN_MARGIN_SAMPLES) / RUN_GRAIN_SAMPLES) *
  RUN_GRAIN_SAMPLES;

/** Source seconds at run sample `index`, on the integral every consumer shares. */
export function runSourceTime(run: RampRun, index: number) {
  const [n, d] = run.phase;
  const curve =
    (run.first * RUN_BLOCK_SAMPLES + index - Number(n) / Number(d)) /
    AUDIO_SAMPLE_RATE;
  return (
    run.zero / 1e6 + sourceTimeAt({ target: "rate", points: run.points }, curve)
  );
}

/** Two documents name the same run of the same file this way. */
export const runId = (src: string, run: RampRun) =>
  `${src}\0${JSON.stringify(run)}`;

const floorDiv = (n: bigint, d: bigint) =>
  n / d - (n < 0n && n % d !== 0n ? 1n : 0n);

/**
 * The run each sounding ramp piece of a document slices, by `placedMedia` key. Pieces of one
 * file on one curve, with one `zero` and one curve zero, are a family; each piece's samples,
 * widened to whole blocks, join the family's other pieces that touch them, and the run starts
 * on the first of those blocks. It reaches as far as its last piece needs, not to a block. A
 * piece whose run would not fit in a WAV maps to null and plays HyperFrames' own rate path, in
 * the viewer and export alike.
 */
export function documentRampRuns({
  fps,
  placed,
}: ReturnType<typeof placedMedia>) {
  const block = BigInt(RUN_BLOCK_SAMPLES);
  const rate = BigInt(AUDIO_SAMPLE_RATE);
  type Member = { key: string; start: bigint; end: bigint };
  const families = new Map<
    string,
    { src: string; run: Omit<RampRun, "first">; members: Member[] }
  >();
  for (const [key, item] of placed) {
    if (
      item.kind !== "media" ||
      item.loop ||
      item.silent ||
      typeof item.curve !== "object"
    )
      continue;
    const piece = resolvePiece(item, fps);
    if (piece.line.kind !== "ramp") continue;
    const { start, end } = piece.samples;
    if (end <= start) continue;
    const zero = piece.line.curveZero;
    const base = floorDiv(zero.n * rate, zero.d);
    const phase = fraction(zero.n * rate - base * zero.d, zero.d);
    const points = piece.line.rate.points;
    const family = `${item.src}\0${JSON.stringify(points)}\0${piece.zero}\0${zero.n}/${zero.d}`;
    const entry = families.get(family) ?? {
      src: item.src,
      run: {
        points,
        zero: piece.zero,
        phase: [String(phase.n), String(phase.d)],
      },
      members: [],
    };
    entry.members.push({ key, start: start - base, end: end - base });
    families.set(family, entry);
  }
  const runs = new Map<string, (RunSlice & { src: string }) | null>();
  for (const { src, run, members } of families.values()) {
    const spans = members
      .map((member) => ({
        member,
        first: floorDiv(member.start, block),
        end: -floorDiv(-member.end, block),
      }))
      .sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
    for (let index = 0; index < spans.length;) {
      const first = spans[index]!.first;
      let end = spans[index]!.end;
      let next = index + 1;
      while (next < spans.length && spans[next]!.first <= end) {
        if (spans[next]!.end > end) end = spans[next]!.end;
        next++;
      }
      const whole: RampRun = { ...run, first: Number(first) };
      const offset = first * block;
      const members = spans.slice(index, next).map(({ member }) => member);
      const frames = Number(
        members.reduce(
          (last, { end }) => (end > last ? end : last),
          members[0]!.end,
        ) - offset,
      );
      const built = runBuildFrames(frames);
      const fits =
        built <= MAX_WAV_FRAMES &&
        (runSourceTime(whole, built) - runSourceTime(whole, 0)) *
          AUDIO_SAMPLE_RATE <=
          MAX_WAV_FRAMES;
      for (const member of members)
        runs.set(
          member.key,
          fits
            ? {
                src,
                run: whole,
                from: Number(member.start - offset),
                to: Number(member.end - offset),
                frames,
              }
            : null,
        );
      index = next;
    }
  }
  return runs;
}
