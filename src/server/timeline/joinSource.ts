import { transform, transformStyleAttribute } from "lightningcss";
import {
  isSubCompositionHost,
  parseNumeric,
  parseStartExpression,
} from "@hyperframes/parsers";
import { toSeconds } from "../../shared/timeline/apply";
import { elementClip } from "../../shared/timeline/element";
import {
  REGION_STYLE_ATTRIBUTE,
  regionStyle,
} from "../../shared/timeline/regionStyle";
import { isAudioKind } from "../../shared/timeline/schema";
import type { Clip } from "../../shared/timeline/schema";
import {
  compositionSize,
  scopeElements,
  trackStackingStyle,
} from "./composition";
import type { ParsedComposition } from "./composition";
import {
  KEYFRAMES_ATTRIBUTE,
  keyframesAttribute,
  keyframeStyle,
} from "./keyframes";
import { titleStyle } from "./titles";
import { transitionStyle } from "./transitions";

type SourceElement = ParsedComposition["root"];

// Only declarations that do not use the pieces' identity, timing, or position in
// the document can take part in a source join. Cutroom's generated sheets are
// checked against their compiler output separately.
const joinPaint = new Set([
  "box-sizing",
  "color",
  "background",
  "background-color",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "width",
  "height",
  "overflow",
  "overflow-x",
  "overflow-y",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "position",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "object-fit",
  "object-position",
  "z-index",
  "opacity",
  "scale",
  "translate",
  "rotate",
  "transform",
  "transform-origin",
  "clip-path",
  "border-radius",
  "box-shadow",
  "filter",
  "outline",
  "outline-color",
  "outline-width",
  "outline-style",
  "border",
  "border-color",
  "border-style",
  "border-width",
  "display",
  "visibility",
  "pointer-events",
]);

/** Refuses stylesheet rules that may observe removing a sibling or changing a clip's attributes. */
function joinStyles(parsed: ParsedComposition, elements: SourceElement[]) {
  const { fps, clips } = parsed.timeline;
  const regions = regionStyle(parsed.timeline, compositionSize(parsed.root));
  const managed = new Set([
    regions &&
      `<style ${REGION_STYLE_ATTRIBUTE}="1">\n${regions.css}\n</style>`,
    "<style data-cutroom-track-layer>@layer cutroom-tracks;</style>",
    trackStackingStyle(
      parsed.root.attrs["data-composition-id"]!,
      clips.filter((clip) => !isAudioKind(clip.kind)).map(({ track }) => track),
    ),
    titleStyle(clips.flatMap((clip) => clip.title?.font ?? [])),
    transitionStyle(),
    keyframeStyle(
      clips.flatMap(
        (clip) =>
          keyframesAttribute(elementClip(clip, fps).keyframes, fps) ?? [],
      ),
      fps,
    ),
  ]);
  const ids = new Set<string>();
  let stable = true;
  for (const element of elements) {
    if (element.tag !== "style") continue;
    if (managed.has(parsed.html.slice(element.start, element.end))) continue;
    try {
      transform({
        filename: "composition.css",
        code: Buffer.from(
          parsed.html.slice(
            element.openEnd,
            parsed.nodes[element.index]?.own[1]?.[0],
          ),
        ),
        visitor: {
          Rule(rule) {
            if (
              ![
                "style",
                "media",
                "supports",
                "font-face",
                "layer-block",
                "layer-statement",
              ].includes(rule.type) ||
              (rule.type === "style" &&
                rule.value.declarations?.importantDeclarations?.some(
                  ({ property }) =>
                    property === "position" || property === "display",
                ))
            )
              stable = false;
          },
          Selector(selector) {
            for (const part of selector) {
              if (part.type === "id") ids.add(part.name);
              else if (
                part.type !== "class" &&
                part.type !== "type" &&
                part.type !== "universal" &&
                !(part.type === "pseudo-class" && part.kind === "root") &&
                !(
                  part.type === "combinator" &&
                  (part.value === "child" || part.value === "descendant")
                )
              )
                stable = false;
            }
          },
          Declaration(declaration) {
            if (!joinPaint.has(declaration.property)) stable = false;
          },
          Url({ url }) {
            if (url.startsWith("#")) stable = false;
          },
        },
      });
    } catch {
      stable = false;
    }
  }
  return { stable, ids };
}

const joinWindow = new Set([
  "id",
  "data-hf-id",
  "data-start",
  "data-duration",
  "data-media-start",
  "data-playback-start",
  "data-link",
  "data-sync-origin",
  "data-automation",
  "data-fade-in",
  "data-fade-out",
  KEYFRAMES_ATTRIBUTE,
]);

/** Prove that deleting the second source element preserves the media's authored presentation. */
export function joinSourceCheck(
  parsed: ParsedComposition,
  safeMarkup: boolean,
) {
  const elements = scopeElements(parsed.roots, parsed.scope);
  const css = joinStyles(parsed, elements);
  const startReferences = new Set(
    elements.flatMap(({ attrs }) => {
      const start = parseStartExpression(attrs["data-start"]);
      return start?.kind === "reference" ? [start.refId] : [];
    }),
  );
  const { fps } = parsed.timeline;
  const context = !safeMarkup
    ? "this composition has scripts or active markup that may depend on the cut"
    : parsed.scope !== "document" ||
        elements.some(
          (element) => element !== parsed.root && isSubCompositionHost(element),
        )
      ? "the source uses a scene whose styles and scripts may depend on the cut"
      : elements.some(
            ({ tag, attrs }) =>
              tag === "link" &&
              attrs.rel?.toLowerCase().split(/\s+/).includes("stylesheet"),
          )
        ? "this composition loads a stylesheet that may depend on the cut"
        : !css.stable
          ? "this composition has styles that may depend on the cut"
          : undefined;

  const sameWindow = (attrs: SourceElement["attrs"], clip: Clip) => {
    const seconds = (name: string, expected: number, optional = false) =>
      attrs[name] === undefined
        ? optional && expected === 0
        : parseNumeric(attrs[name]) === expected;
    const automation = attrs["data-automation"];
    return (
      attrs["data-end"] === undefined &&
      seconds("data-start", toSeconds(clip.start, fps)) &&
      seconds("data-duration", toSeconds(clip.duration, fps)) &&
      !(
        attrs["data-media-start"] !== undefined &&
        attrs["data-playback-start"] !== undefined
      ) &&
      seconds(
        attrs["data-playback-start"] === undefined
          ? "data-media-start"
          : "data-playback-start",
        clip.mediaStart ?? 0,
        true,
      ) &&
      seconds("data-fade-in", toSeconds(clip.fadeIn, fps), true) &&
      seconds("data-fade-out", toSeconds(clip.fadeOut, fps), true) &&
      (attrs[KEYFRAMES_ATTRIBUTE] ?? null) ===
        keyframesAttribute(clip.keyframes, fps) &&
      Bun.deepEquals(
        automation ? JSON.parse(automation) : null,
        clip.automation ? JSON.parse(clip.automation) : null,
      )
    );
  };
  return (pairs: readonly [Clip, Clip][]) => {
    for (const [from, to] of pairs) {
      const refuse = (reason: string) =>
        `Can't join ${to.id} because ${reason}.`;
      const a = parsed.elements.get(from.id);
      const b = parsed.elements.get(to.id);
      if (!a || !b) return refuse("the source pieces must already be saved");
      const at = parsed.root.children.indexOf(a);
      if (
        a.tag !== b.tag ||
        !["video", "audio"].includes(a.tag) ||
        a.inner ||
        b.inner ||
        !parsed.nodes[a.index]?.own[1] ||
        !parsed.nodes[b.index]?.own[1] ||
        !a.attrs.src ||
        !b.attrs.src ||
        at < 0 ||
        parsed.root.children[at + 1] !== b ||
        parsed.html.slice(a.end, b.start).trim()
      )
        return refuse(
          "the source must be adjacent, plain media elements in the same composition",
        );
      const attrsOf = (element: SourceElement) =>
        Object.fromEntries(
          Object.entries(element.attrs).filter(
            ([name]) => !joinWindow.has(name),
          ),
        );
      if (!Bun.deepEquals(attrsOf(a), attrsOf(b)))
        return refuse(
          "the source elements have different classes, styles, or other attributes",
        );
      if (context) return refuse(context);
      if (
        [a, b].some(
          ({ attrs }) =>
            css.ids.has(attrs.id ?? "") ||
            css.ids.has(attrs["data-hf-id"] ?? ""),
        )
      )
        return refuse("a stylesheet targets one of the source elements by ID");
      if (startReferences.has(from.id) || startReferences.has(to.id))
        return refuse(
          "another element's timing depends on one of these pieces",
        );
      if (
        a.attrs.controls !== undefined ||
        a.attrs["data-fx-chain"] !== undefined
      )
        return refuse(
          "media controls or clip effects may change across the cut",
        );
      const aOrigin = a.attrs["data-sync-origin"];
      const bOrigin = b.attrs["data-sync-origin"];
      if (
        aOrigin !== bOrigin &&
        !(from.link && to.link && aOrigin === from.link && bOrigin === to.link)
      )
        return refuse("the source elements have different sync partners");
      let stable = true;
      let absolute = false;
      try {
        transformStyleAttribute({
          code: Buffer.from(a.attrs.style ?? ""),
          visitor: {
            Declaration(declaration) {
              if (!joinPaint.has(declaration.property)) stable = false;
              if (declaration.property === "position")
                absolute =
                  declaration.value.type === "absolute" ||
                  declaration.value.type === "fixed";
            },
            Url({ url }) {
              if (url.startsWith("#")) stable = false;
            },
          },
        });
      } catch {
        stable = false;
      }
      if (!stable || (a.tag === "video" && !absolute))
        return refuse(
          "the source style may depend on the media element's place in the document",
        );
      if (!sameWindow(a.attrs, from) || !sameWindow(b.attrs, to))
        return refuse(
          "the source timing, fades, or animation do not match the timeline cut",
        );
    }
  };
}
