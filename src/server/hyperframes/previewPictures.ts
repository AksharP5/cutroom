import { parseHTML } from "linkedom";
import { parseFpsWithDefault } from "@hyperframes/core";
import {
  parseNumeric,
  parseStartExpression,
} from "@hyperframes/parsers/composition-contract";
import {
  readMediaOffsetSeconds,
  readPlaybackRate,
} from "@hyperframes/parsers/media-duration";
import {
  hostInPointSeconds,
  readMediaStartBasis,
} from "@hyperframes/core/media-timing";
import { resolveRateSpec } from "@hyperframes/core/speed-ramp";
import { attrMicros, place } from "../../shared/timeline/piece";
import type { Composition } from "../../shared/timeline/piece";
import { packTime } from "../../shared/timeline/pictureClock";
import type { PreviewPictures } from "../../shared/timeline/pictureClock";

/** Read picture placement from the same compiled instances the preview will show. */
export function previewPictures(html: string): PreviewPictures | null {
  const { document } = parseHTML(html);
  const root =
    document.querySelector('[data-composition-id][data-root="true"]') ??
    document.querySelector("[data-composition-id]");
  if (!root) return null;
  const rate = parseFpsWithDefault(root.getAttribute("data-fps") ?? undefined);
  if (!rate.ok) return null;
  const fps = rate.value;
  const videos = new Set<string>();
  const ambiguous = new Set<string>();
  const read = (parent: Element): Composition => {
    const elements: Composition["elements"][number][] = [];
    const visit = (node: Element) => {
      const get = (name: string) => node.getAttribute(name);
      const id = get("data-hf-render-id") ?? get("id") ?? get("data-hf-id");
      const start = parseStartExpression(get("data-start") ?? "0");
      if (id && start) {
        const duration = parseNumeric(get("data-duration"));
        const end = parseNumeric(get("data-end"));
        const window = {
          id,
          start:
            start.kind === "reference"
              ? { ref: start.refId, offsetUs: attrMicros(start.offset) }
              : { us: attrMicros(start.value) },
          durationUs: duration === null ? undefined : attrMicros(duration),
          endUs: end === null ? undefined : attrMicros(end),
        };
        const tag = node.localName;
        if (get("data-composition-id") !== null) {
          elements.push({
            ...window,
            kind: "host",
            mediaStartUs: attrMicros(hostInPointSeconds(node)),
            child: read(node),
          });
          return;
        }
        if (
          tag === "video" &&
          get("src") &&
          !node.hasAttribute("data-var-src")
        ) {
          if (videos.has(id)) ambiguous.add(id);
          videos.add(id);
          const curve = resolveRateSpec(
            get("data-automation"),
            readPlaybackRate(get),
          );
          elements.push({
            ...window,
            kind: "media",
            src: get("src")!,
            stored: {
              mediaStart: Number(attrMicros(readMediaOffsetSeconds(get))),
              ...(typeof curve === "object" && curve.offset !== undefined
                ? { offset: Number(attrMicros(curve.offset)) }
                : {}),
            },
            curve,
            loop: node.hasAttribute("loop"),
            global:
              readMediaStartBasis(get("data-hf-media-start-basis")) ===
              "global",
          });
        } else {
          elements.push({ ...window, kind: "text" });
        }
      }
      for (const child of node.children) visit(child);
    };
    for (const child of parent.children) visit(child);
    return { fps, elements };
  };
  const pieces = place(read(root)).flatMap((media) =>
    media.kind === "media" && !ambiguous.has(media.id)
      ? [
          {
            id: media.id,
            src: media.src,
            start: packTime(media.local.start),
            anchor: packTime(
              media.loop ? media.played.start : media.edge.start,
            ),
            mediaStart: media.stored.mediaStart,
            curve: typeof media.curve === "number" ? media.curve : undefined,
            automation:
              typeof media.curve === "object"
                ? JSON.stringify({
                    version: 1,
                    lanes: [media.curve],
                  })
                : undefined,
            loop: Boolean(media.loop),
          },
        ]
      : [],
  );
  return { fps, pieces };
}
