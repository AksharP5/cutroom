import { parseSourceDocument } from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import { CaptionsSchema } from "../../shared/captions";
import type { CaptionStyle, Captions } from "../../shared/captions";
import { canonicalSeconds } from "../../shared/timeline/apply";
import { captionInset } from "../../shared/safeZones";
import { cueOf } from "./subtitles";

/** Marks a captions composition's root; the value is the file format's version. */
export const CAPTIONS_ATTRIBUTE = "data-cutroom-captions";
const CAPTIONS_VERSION = "1";

/** A word placed on the timeline, in seconds of the composition it plays in. */
export interface TimedWord {
  id: string;
  text: string;
  start: number;
  end: number;
}

/** The composition a captions file renders into. */
export interface CaptionsFrame {
  /** The captions composition id, `[a-z0-9-]`, also the scope of its stylesheet. */
  id: string;
  width: number;
  height: number;
}

/** A silence this long between words starts a new line. */
const PAUSE = 0.5;
/** How long a line stays up after its last word, unless the next line starts sooner. */
const HOLD = 0.6;
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const CLAUSE_END = /[,;:–—]["'”’)\]]*$/;

const length = (words: readonly TimedWord[]) =>
  words.reduce((sum, word) => sum + word.text.length, words.length - 1);

/** Words split before each word for which `breaks` is true. */
const runs = (
  words: readonly TimedWord[],
  breaks: (previous: TimedWord, word: TimedWord) => boolean,
) =>
  words.reduce<TimedWord[][]>((all, word) => {
    const run = all.at(-1);
    if (run && !breaks(run.at(-1)!, word)) run.push(word);
    else all.push([word]);
    return all;
  }, []);

/**
 * A phrase in the fewest lines that fit `maxChars`, as even in length as they can be, ending
 * lines at clause ends where that costs little balance. A word longer than a line has its own.
 */
function breakLines(phrase: readonly TimedWord[], maxChars: number) {
  const fits = (from: number, to: number) =>
    to - from === 1 || length(phrase.slice(from, to)) <= maxChars;
  // The fewest lines, as filling each line in turn finds them.
  let count = 0;
  for (let from = 0; from < phrase.length; count++) {
    let to = from + 1;
    while (to < phrase.length && fits(from, to + 1)) to++;
    from = to;
  }
  if (count <= 1) return [[...phrase]];
  const average = length(phrase) / count;
  const clauseBonus = (maxChars / 3) ** 2;
  // cost[to] is the best layout of the words before `to`; an extra line outweighs any balance.
  const cost = [0, ...phrase.map(() => Infinity)];
  const start = phrase.map(() => 0);
  for (let to = 1; to <= phrase.length; to++)
    for (let from = to - 1; from >= 0 && fits(from, to); from--) {
      const value =
        cost[from]! +
        1e6 +
        (length(phrase.slice(from, to)) - average) ** 2 -
        (to < phrase.length && CLAUSE_END.test(phrase[to - 1]!.text)
          ? clauseBonus
          : 0);
      if (value < cost[to]!) {
        cost[to] = value;
        start[to - 1] = from;
      }
    }
  const lines: TimedWord[][] = [];
  for (let to = phrase.length; to > 0; to = start[to - 1]!)
    lines.unshift(phrase.slice(start[to - 1], to));
  return lines;
}

/**
 * Words in readable lines. A sentence end, a pause, or the end of an imported subtitle cue
 * always ends a line, and the words between are broken into lines that fit the caption safe
 * area. Each line shows from its first word until a short hold after its last one (an imported
 * cue keeps its own end), and never overlaps the next.
 */
export function groupWords(
  words: readonly TimedWord[],
  frame: Pick<CaptionsFrame, "width" | "height">,
) {
  const maxChars = frame.width >= frame.height ? 42 : 24;
  const lines = runs(
    words,
    (previous, word) =>
      word.start - previous.end >= PAUSE ||
      SENTENCE_END.test(previous.text) ||
      cueOf(previous.id) !== cueOf(word.id),
  ).flatMap((phrase) => breakLines(phrase, maxChars));
  return lines.map((line, index) => {
    const start = line[0]!.start;
    const next = lines[index + 1]?.[0]!.start ?? Infinity;
    // An imported cue already ends where its author wanted.
    const hold = cueOf(line.at(-1)!.id) ? 0 : HOLD;
    const end = Math.min(
      Math.max(...line.map((word) => word.end)) + hold,
      next,
    );
    return { start, end: Math.max(end, start + 0.001), words: line };
  });
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const ACCENT = "#ffd54a";
/** What each style adds to the shared layout: weight, and the per-word motion it seeks. */
const STYLE_RULES: Record<CaptionStyle, { weight: number; word: string }> = {
  karaoke: {
    weight: 700,
    // Ahead of the voice the word is dim; while it is spoken, the accent; after, white.
    word: "animation-name:cutroom-caption-ahead,cutroom-caption-now;animation-duration:var(--a),var(--d);animation-delay:0s,var(--a);animation-timing-function:linear",
  },
  highlight: {
    weight: 700,
    word: "animation-name:cutroom-caption-mark;animation-duration:var(--d);animation-delay:var(--a);animation-timing-function:linear",
  },
  plain: { weight: 600, word: "" },
};

/**
 * The captions stylesheet. Lines sit where `captionInset` puts them, the zone the viewer's
 * safe-zone overlay draws. The runtime's CSS adapter seeks each
 * word's animation in its line's own time, so preview and export draw the same frame.
 */
function stylesheet(style: CaptionStyle, frame: CaptionsFrame) {
  const scope = `[data-composition-id="${frame.id}"]`;
  const size = Math.round(Math.min(frame.width, frame.height) * 0.056);
  const inset = captionInset(frame);
  const { weight, word } = STYLE_RULES[style];
  return [
    `@keyframes cutroom-caption-ahead{from,to{color:rgba(255,255,255,.5)}}`,
    `@keyframes cutroom-caption-now{from,to{color:${ACCENT}}}`,
    `@keyframes cutroom-caption-mark{from,to{background-color:${ACCENT};color:#111;text-shadow:none}}`,
    `${scope}{position:absolute;inset:0;overflow:visible;pointer-events:none}`,
    `${scope} .caption-stage{position:absolute;left:${inset.side}%;right:${inset.side}%;top:0;bottom:${inset.bottom}%}`,
    `${scope} .caption-group{position:absolute;left:0;right:0;bottom:0;max-width:100%;margin:0;text-align:center;font-size:${size}px;line-height:1.25;font-weight:${weight};color:#fff;overflow-wrap:anywhere}`,
    `${scope} .caption-word{display:inline-block;padding:0 .12em;border-radius:.16em;text-shadow:0 .05em .2em rgba(0,0,0,.8),0 0 .08em rgba(0,0,0,.9);${word}}`,
  ].join("\n");
}

const seconds = (value: number) => String(canonicalSeconds(value));

/** A HyperFrames sub-composition that shows the captions, one timed line after another. */
export function renderCaptions(
  captions: Captions,
  frame: CaptionsFrame,
  duration: number,
): string {
  const groups = captions.groups.map((group, line) => {
    const words = group.words.map((word, index) => {
      const next = group.words[index + 1]?.start ?? group.end;
      const at = Math.max(0, word.start - group.start);
      const length = Math.max(0, next - word.start);
      return `<span class="caption-word" data-word-id="${escapeHtml(word.id)}" style="--a:${seconds(at)}s;--d:${seconds(length)}s">${escapeHtml(word.text)}</span>`;
    });
    // Lint and Studio address timed elements by id; the composition id keeps them unique.
    return `<div id="${frame.id}-line-${line + 1}" class="caption-group clip" data-start="${seconds(group.start)}" data-duration="${seconds(group.end - group.start)}">${words.join(" ")}</div>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>Captions</title></head>
<body><template>
<style>
${stylesheet(captions.style, frame)}
</style>
<div data-composition-id="${frame.id}" data-width="${frame.width}" data-height="${frame.height}" data-duration="${seconds(duration)}" ${CAPTIONS_ATTRIBUTE}="${CAPTIONS_VERSION}" data-caption-style="${captions.style}" data-caption-transcript="${escapeHtml(captions.transcriptId)}">
<div class="caption-stage">
${groups.join("\n")}
</div>
</div>
</template></body></html>
`;
}

const unreadable = () =>
  new HttpError(
    409,
    "The captions file was changed outside Cutroom, so it cannot be read back. Undo that change, or remove the captions clip and add captions again.",
  );

/**
 * Captions from a file Cutroom wrote, or null for any other composition. A file that claims to be
 * captions must pass the same schema Cutroom writes from, or it is refused rather than guessed.
 */
export function readCaptions(
  html: string,
): { captions: Captions; frame: CaptionsFrame } | null {
  const template = parseSourceDocument(html).document.querySelector("template");
  if (!template) return null;
  const { document } = parseSourceDocument(template.innerHTML);
  const root = document.querySelector(`[${CAPTIONS_ATTRIBUTE}]`);
  if (!root) return null;
  const id = root.getAttribute("data-composition-id") ?? "";
  const width = Number(root.getAttribute("data-width"));
  const height = Number(root.getAttribute("data-height"));
  if (
    root.getAttribute(CAPTIONS_ATTRIBUTE) !== CAPTIONS_VERSION ||
    !/^[a-z0-9-]{1,80}$/.test(id) ||
    !(width > 0 && height > 0)
  )
    throw unreadable();
  const parsed = CaptionsSchema.safeParse({
    style: root.getAttribute("data-caption-style"),
    transcriptId: root.getAttribute("data-caption-transcript"),
    groups: [...root.querySelectorAll(".caption-group")].map((group) => {
      const start = Number(group.getAttribute("data-start"));
      return {
        start,
        end: canonicalSeconds(
          start + Number(group.getAttribute("data-duration")),
        ),
        words: [...group.querySelectorAll(".caption-word")].map((word) => ({
          id: word.getAttribute("data-word-id"),
          text: word.textContent,
          start: canonicalSeconds(
            start +
              Number(
                /--a:([0-9.]+)s/.exec(word.getAttribute("style") ?? "")?.[1],
              ),
          ),
        })),
      };
    }),
  });
  if (!parsed.success) throw unreadable();
  return { captions: parsed.data, frame: { id, width, height } };
}
