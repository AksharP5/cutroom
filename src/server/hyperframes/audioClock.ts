import {
  MEDIA_RENDER_ID_ATTR,
  parseFpsWithDefault,
  readElementRateSpec,
  readMediaStart,
} from "@hyperframes/core";
import {
  hostInPointSeconds,
  MEDIA_START_BASIS_ATTR,
  readMediaStartBasis,
} from "@hyperframes/core/media-timing";
import type { AudioElement } from "@hyperframes/engine";
import {
  readClipTiming,
  resolveSubCompositionContent,
} from "@hyperframes/parsers";
import { parseHTML } from "linkedom";
import {
  AUDIO_SAMPLE_RATE,
  attrMicros,
  frames,
  micros,
  place,
  resolvePiece,
  sampleOf,
  secondsOf,
  sourceSampleOffset,
} from "../../shared/timeline/piece.ts";
import type { Composition } from "../../shared/timeline/piece.ts";
import type { Fps } from "../../shared/timeline/schema.ts";

export { AUDIO_SAMPLE_RATE };
export const audioFrameSample = (frame: number, fps: Fps) =>
  Number(sampleOf(frames(frame, fps)));

export type AudioMixElement = AudioElement & {
  samples?: { start: number; end: number };
};

const HOST =
  "[data-composition-id], [data-composition-src], [data-composition-file]";
const audioKey = (audio: AudioElement) => `${audio.type}:${audio.id}`;

function documentFps(root: Element | null): Fps {
  const parsed = parseFpsWithDefault(
    root?.getAttribute("data-fps") ?? undefined,
  );
  return parsed.ok ? parsed.value : { num: 30, den: 1 };
}

/** Use the compiled document's render ids and host instances, but read each
 * timestamp on the grid of the file that authored it. */
export function sampleGridAudio(
  audios: AudioElement[],
  html: string,
  subCompositions: ReadonlyMap<string, string> = new Map(),
  beforeProbe?: AudioElement[],
): AudioMixElement[] {
  if (!audios.length) return audios;
  const { document } = parseHTML(html);
  const root = document.querySelector(HOST);
  const fps = documentFps(root);
  const childRates = new Map<string, Fps>();
  const knownWindows = new Set<string>();

  function childFps(host: Element): Fps {
    const file = host.getAttribute("data-composition-file");
    const source = file ? subCompositions.get(file) : undefined;
    if (!file || source === undefined) return documentFps(host);
    const cached = childRates.get(file);
    if (cached) return cached;
    const { contentHtml } = resolveSubCompositionContent(
      source,
      parseHTML(source).document,
    );
    const rate = documentFps(
      parseHTML(contentHtml).document.querySelector(HOST),
    );
    childRates.set(file, rate);
    return rate;
  }

  function composition(container: ParentNode, ownFps: Fps): Composition {
    const entries: { element: Element; id: string; host: boolean }[] = [];
    const byId = new Map<string, string>();
    function walk(parent: ParentNode) {
      for (const element of parent.children) {
        if (element.localName === "template") continue;
        const host = element !== root && element.matches(HOST);
        const authoredId = element.getAttribute("id");
        const renderId =
          element.getAttribute(MEDIA_RENDER_ID_ATTR) || authoredId;
        if (!host && !renderId) {
          walk(element);
          continue;
        }
        const id =
          renderId && element.localName === "audio"
            ? `audio:${renderId}`
            : renderId && element.localName === "video"
              ? `video:${renderId}-audio`
              : String(entries.length);
        entries.push({ element, id, host });
        if (authoredId && !byId.has(authoredId)) byId.set(authoredId, id);
        const compositionId = element.getAttribute("data-composition-id");
        if (host && compositionId && !byId.has(compositionId))
          byId.set(compositionId, id);
        if (!host) walk(element);
      }
    }
    walk(container);
    return {
      fps: ownFps,
      elements: entries.map(({ element, id, host }) => {
        const read = readClipTiming(element);
        const expression = read.startExpression;
        const window = {
          id,
          start:
            expression?.kind === "reference"
              ? {
                  ref: byId.get(expression.refId) ?? "",
                  offsetUs: attrMicros(expression.offset),
                }
              : { us: attrMicros(expression?.value ?? 0) },
          ...(read.durationSource === "duration" &&
            read.duration !== null && {
              durationUs: attrMicros(read.duration),
            }),
          ...(read.durationSource === "legacy-end" &&
            read.end !== null && {
              endUs: attrMicros(read.end),
            }),
        };
        if (host)
          return {
            ...window,
            kind: "host",
            mediaStartUs: attrMicros(hostInPointSeconds(element)),
            child: composition(element, childFps(element)),
          };
        if (id.startsWith("audio:") || id.startsWith("video:")) {
          if (window.durationUs !== undefined || window.endUs !== undefined)
            knownWindows.add(id);
          const rate = readElementRateSpec(element);
          return {
            ...window,
            kind: "media",
            src: element.getAttribute("src") ?? "",
            curve:
              typeof rate === "number"
                ? rate
                : { target: rate.target, points: rate.points },
            stored: {
              mediaStart: Number(attrMicros(readMediaStart(element))),
              ...(typeof rate === "object" &&
                rate.offset !== undefined && {
                  offset: Number(attrMicros(rate.offset)),
                }),
            },
            loop: element.hasAttribute("loop"),
            global:
              readMediaStartBasis(
                element.getAttribute(MEDIA_START_BASIS_ATTR),
              ) === "global",
          };
        }
        return { ...window, kind: "text" };
      }),
    };
  }

  const placed = new Map(
    place(composition(document, fps)).map((item) => [item.id, item]),
  );
  const staticAudio =
    beforeProbe &&
    new Map(beforeProbe.map((audio) => [audioKey(audio), audio]));
  return audios.flatMap((audio) => {
    const key = audioKey(audio);
    const original = staticAudio?.get(key);
    // Script-created tracks and unknown lengths still use the producer's measurements.
    if (staticAudio && !original) return [audio];
    const item = placed.get(key);
    if (item?.kind !== "media") return knownWindows.has(key) ? [] : [audio];
    const piece = resolvePiece({ ...item, loop: audio.loop }, fps);
    const start = Number(piece.samples.start);
    const measuredEnd = original && Math.abs(audio.end - original.end) > 1e-6;
    const end = measuredEnd
      ? Number(sampleOf(micros(attrMicros(audio.end))))
      : Number(piece.samples.end);
    if (end <= start) return [];
    const offset = sourceSampleOffset(piece);
    const mediaStart =
      offset !== null &&
      audio.playbackRate === 1 &&
      (!original || Math.abs(audio.mediaStart - original.mediaStart) <= 1e-6)
        ? Number(piece.samples.start + offset) / AUDIO_SAMPLE_RATE
        : audio.mediaStart;
    return [
      {
        ...audio,
        start: secondsOf(piece.played.start),
        end: measuredEnd ? audio.end : secondsOf(piece.played.end),
        mediaStart,
        samples: { start, end },
      },
    ];
  });
}
