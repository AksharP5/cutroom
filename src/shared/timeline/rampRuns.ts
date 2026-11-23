import { sourceTimeAt } from "@hyperframes/core/speed-ramp";
import type { HfAutomationPoint } from "@hyperframes/core/audio-automation";
import { AUDIO_SAMPLE_RATE, fraction, resolvePiece } from "./piece.ts";
import type { placedMedia } from "./placedMedia.ts";

/** A run covers whole blocks of 10 s, counted from the sample curve zero falls in. */
export const RUN_BLOCK_SAMPLES = 480_000;
/** The most stereo 16-bit frames a WAV can hold. */
export const MAX_WAV_FRAMES = Math.floor((0xffffffff - 36) / 4);

/**
 * One continuous stretch of a ramp's sound: everything that decides its samples, and nothing
 * about where it sits on the timeline, so a moved ramp or an undo finds the same run.
 */
export type RampRun = {
  points: HfAutomationPoint[];
  /** Source microseconds at curve zero. */
  zero: number;
  /** How far curve zero lies past the sample it falls in, as an exact fraction of a sample. */
  phase: [numerator: string, denominator: string];
  /** The first block, counted from that sample. */
  first: number;
  /** Blocks in the run. */
  count: number;
};

/** The part of a run one piece plays: run samples `[from, to)`. */
export type RunSlice = { run: RampRun; from: number; to: number };

export const runFrames = (run: RampRun) => run.count * RUN_BLOCK_SAMPLES;

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
 * The run each sounding ramp piece of a document slices, by `placedMedia` key. Pieces of one file on one
 * curve, with one `zero` and one curve zero, are a family; each piece's samples, widened to
 * whole blocks, join the family's other pieces that touch them. A piece whose run would not fit
 * in a WAV maps to null and plays HyperFrames' own rate path, in the viewer and export alike.
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
    { src: string; run: Omit<RampRun, "first" | "count">; members: Member[] }
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
      const whole: RampRun = {
        ...run,
        first: Number(first),
        count: Number(end - first),
      };
      const frames = runFrames(whole);
      const fits =
        frames <= MAX_WAV_FRAMES &&
        (runSourceTime(whole, frames) - runSourceTime(whole, 0)) *
          AUDIO_SAMPLE_RATE <=
          MAX_WAV_FRAMES;
      for (const { member } of spans.slice(index, next)) {
        const offset = first * block;
        runs.set(
          member.key,
          fits
            ? {
                src,
                run: whole,
                from: Number(member.start - offset),
                to: Number(member.end - offset),
              }
            : null,
        );
      }
      index = next;
    }
  }
  return runs;
}
