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
import {
  readClipTiming,
  resolveSubCompositionContent,
} from "@hyperframes/parsers";
import { HF_AUDIO_AUTOMATION_ATTR } from "@hyperframes/core/audio-automation";
import {
  HF_AUDIO_FADE_IN_ATTR,
  HF_AUDIO_FADE_OUT_ATTR,
  readFadeSeconds,
} from "@hyperframes/core/audio-fade";
import { parseHTML } from "linkedom";
import { mixFromHead } from "./mix.ts";
import { attrMicros, place, secondsOf, subtract } from "./piece.ts";
import type { Composition, PlacedElement, Start } from "./piece.ts";
import type { Fps } from "./schema.ts";

export const HOST_ATTRIBUTES = [
  "data-composition-id",
  "data-composition-src",
  "data-composition-file",
];
const HOST = HOST_ATTRIBUTES.map((name) => `[${name}]`).join(", ");

type Attributes = Pick<Element, "getAttribute">;

/** An element's own timing as authored, read the way export reads it: `data-duration` wins. */
export function authoredWindow(
  element: Attributes,
  idOf: (refId: string) => string = (refId) => refId,
) {
  const read = readClipTiming(element);
  const expression = read.startExpression;
  const start: Start =
    expression?.kind === "reference"
      ? {
          ref: idOf(expression.refId),
          offsetUs: attrMicros(expression.offset),
        }
      : { us: attrMicros(expression?.value ?? 0) };
  return {
    start,
    ...(read.durationSource === "duration" &&
      read.duration !== null && { durationUs: attrMicros(read.duration) }),
    ...(read.durationSource === "legacy-end" &&
      read.end !== null && { endUs: attrMicros(read.end) }),
  };
}

/** The key `placedMedia` files a media element under. */
export const placedKey = (tagName: string, element: Attributes) =>
  `${tagName}:${element.getAttribute(MEDIA_RENDER_ID_ATTR) || element.getAttribute("id")}`;

function documentFps(root: Element | null): Fps {
  const parsed = parseFpsWithDefault(
    root?.getAttribute("data-fps") ?? undefined,
  );
  return parsed.ok ? parsed.value : { num: 30, den: 1 };
}

/** Use the compiled document's render ids and host instances, but read each
 * timestamp on the grid of the file that authored it. */
export function placedMedia(
  html: string,
  subCompositions: ReadonlyMap<string, string> = new Map(),
) {
  const { document } = parseHTML(html);
  const root = document.querySelector(HOST);
  const fps = documentFps(root);
  const childRates = new Map<string, Fps>();
  const knownWindows = new Set<string>();

  function childFps(host: Element): Fps {
    const file = host.getAttribute("data-composition-file");
    const source = file ? subCompositions.get(file) : undefined;
    // A served preview keeps the scene file's own root inside the host.
    if (!file || source === undefined)
      return documentFps(
        Array.from(host.children).find((child) =>
          child.hasAttribute("data-hf-inner-root"),
        ) ?? host,
      );
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
        // `matches` would compile the selector again for every element.
        const host =
          element !== root &&
          HOST_ATTRIBUTES.some((name) => element.hasAttribute(name));
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
              ? `video:${renderId}`
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
        const window = {
          id,
          ...authoredWindow(element, (refId) => byId.get(refId) ?? ""),
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
            silent:
              element.hasAttribute("muted") ||
              (element.localName === "video" &&
                ![null, "true"].includes(
                  element.getAttribute("data-has-audio"),
                )),
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
  return { fps, placed, knownWindows };
}

/**
 * Export plays a piece that a trimmed mount cuts from where the mount lets it through: a loop
 * restarts at its in-point there. These attributes give the browser runtime the same start in
 * the piece's own composition, and keep its end. Its fades and lanes stay clip-local, as
 * `mixFromHead` leaves them for export. Empty when nothing is cut. A piece needs a length to be
 * placed at all, so a loop written without one is left as written.
 */
export function startAtPlayed(
  {
    played,
    edge,
    origin,
    local,
  }: Pick<PlacedElement, "played" | "edge" | "origin" | "local">,
  get: (name: string) => string | null,
): [name: string, value: string][] {
  const head = subtract(played.start, edge.start);
  if (head.n === 0n) return [];
  const start = subtract(played.start, origin);
  const fadeIn = get(HF_AUDIO_FADE_IN_ATTR);
  const fadeOut = get(HF_AUDIO_FADE_OUT_ATTR);
  const automation = get(HF_AUDIO_AUTOMATION_ATTR);
  const volume = get("data-volume");
  const mix = mixFromHead(
    {
      fadeIn: readFadeSeconds(fadeIn),
      fadeOut: readFadeSeconds(fadeOut),
      automation,
      volume: volume === null ? null : Number(volume),
    },
    secondsOf(head),
    secondsOf(subtract(local.end, local.start)),
  );
  const changed = (
    name: string,
    before: string | null,
    after: number | string | null,
  ): [string, string][] =>
    after === null ||
    (before === null && after === 0) ||
    (before !== null && String(after) === before)
      ? []
      : [[name, String(after)]];
  return [
    ["data-start", String(secondsOf(start))],
    ["data-duration", String(secondsOf(subtract(local.end, start)))],
    ...(get("data-end") !== null
      ? [["data-end", String(secondsOf(local.end))] as [string, string]]
      : []),
    ...(mix
      ? [
          ...changed(HF_AUDIO_FADE_IN_ATTR, fadeIn, mix.fadeIn),
          ...changed(HF_AUDIO_FADE_OUT_ATTR, fadeOut, mix.fadeOut),
          ...changed(HF_AUDIO_AUTOMATION_ATTR, automation, mix.automation),
        ]
      : []),
  ];
}
