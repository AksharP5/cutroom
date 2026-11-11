import { transform, transformStyleAttribute } from "lightningcss";
import type { Declaration, Selector } from "lightningcss";
import { positionAnimations } from "./positionAnimations";
import type { ParsedComposition } from "./composition";

type Element = ParsedComposition["root"];
const propertyOf = (declaration: Declaration) =>
  declaration.property === "unparsed"
    ? declaration.value.propertyId.property
    : declaration.property;
const affectsCoordinates = (declaration: Declaration) =>
  [
    "transform",
    "translate",
    "rotate",
    "scale",
    "perspective",
    "zoom",
    "offset-path",
  ].includes(propertyOf(declaration));

// GSAP properties which can consume a saved offset on the clip, or change the coordinate
// system on an ancestor. Include setters/plugins that can write these properties indirectly.
const animationCoordinates = {
  x: "clip",
  y: "clip",
  translateX: "clip",
  translateY: "clip",
  xPercent: "clip",
  yPercent: "clip",
  left: "clip",
  top: "clip",
  right: "clip",
  bottom: "clip",
  translate: "clip",
  transform: "clip",
  clearProps: "clip",
  cssText: "clip",
  style: "clip",
  motionPath: "clip",
  bezier: "clip",
  physics2D: "clip",
  physicsProps: "clip",
  scale: "ancestor",
  scaleX: "ancestor",
  scaleY: "ancestor",
  rotate: "ancestor",
  rotation: "ancestor",
  rotationX: "ancestor",
  rotationY: "ancestor",
  rotationZ: "ancestor",
  rotateX: "ancestor",
  rotateY: "ancestor",
  rotateZ: "ancestor",
  z: "ancestor",
  translateZ: "ancestor",
  skew: "ancestor",
  skewX: "ancestor",
  skewY: "ancestor",
  // Origin alone does not change coordinates; accompanying transforms already conflict.
  transformOrigin: "combined",
  svgOrigin: "combined",
  zoom: "ancestor",
  perspective: "ancestor",
  transformPerspective: "ancestor",
  matrix: "ancestor",
} as const;

/** Unknown selectors conservatively match. Only simple compounds can exclude an ancestor. */
function couldMatch(selector: Selector, element: Element) {
  if (
    selector.some(
      (part) => !["type", "id", "class", "universal"].includes(part.type),
    )
  )
    return true;
  return selector.every((part) => {
    if (part.type === "type") return part.name === element.tag;
    if (part.type === "id") return part.name === element.attrs.id;
    if (part.type === "class")
      return (element.attrs.class ?? "").split(/\s+/).includes(part.name);
    return true;
  });
}

export function unsupportedPositions(
  parsed: ParsedComposition,
): Record<string, string> {
  const elements: Element[] = [];
  const parents = new Map<Element, Element>();
  const ids = new Map<string, number>();
  const visit = (nodes: Element[], parent?: Element) => {
    for (const node of nodes) {
      elements.push(node);
      if (node.attrs.id)
        ids.set(node.attrs.id, (ids.get(node.attrs.id) ?? 0) + 1);
      if (parent) parents.set(node, parent);
      visit([...node.children, ...node.content], node);
    }
  };
  visit(parsed.roots);
  const rules: {
    selectors: Selector[];
    translate: boolean;
    important?: boolean;
  }[] = [];
  const animations: { selectors: Selector[]; clip: boolean }[] = [];
  const inline = new Map<
    Element,
    { coordinates: boolean; translate: boolean }
  >();
  let reason = "";
  let gsap = false;
  // Source-only support: unknown scripts refuse all clips they could affect. Only the closed
  // synchronous GSAP grammar below can establish which targets/properties an animation writes.
  // CSS selectors we cannot resolve conservatively match. Live drafts need a unique source id.
  for (const element of elements) {
    if (element.tag === "link" && /stylesheet/i.test(element.attrs.rel ?? ""))
      reason = "Position is unavailable with external stylesheets.";
    if (Object.keys(element.attrs).some((name) => /^on/.test(name)))
      reason = "Position is unavailable with event scripts.";
    if (element.tag === "script") {
      if (
        element.attrs.type &&
        !["text/javascript", "application/javascript"].includes(
          element.attrs.type,
        )
      ) {
        if (element.attrs.type === "module")
          reason = "Position requires synchronous scripts.";
        continue;
      }
      const src = element.attrs.src;
      if (src) {
        if (
          !/(?:^|\/)gsap(?:\.min)?\.js(?:\?.*)?$/.test(src) ||
          "async" in element.attrs ||
          "defer" in element.attrs
        )
          reason = "Position requires synchronous GSAP scripts.";
        else gsap = true;
        continue;
      }
      const script = parsed.html
        .slice(element.openEnd, element.end)
        .replace(/<\/script\s*>$/i, "");
      if (
        /\b(?:setTimeout|setInterval|requestAnimationFrame|addEventListener|Promise|async|import|document|fetch)\b|\.(?:then|call)\s*\(|\bon(?:Start|Update|Complete|Repeat)\s*:/.test(
          script,
        )
      )
        reason = "Position is unavailable with custom or delayed scripts.";
      if (!reason && /\bgsap\b/.test(script) && !gsap)
        reason = "Position requires GSAP to load before animation scripts.";
      try {
        for (const animation of positionAnimations(script)) {
          const conflicts = Object.entries(animationCoordinates).filter(
            ([property, scope]) =>
              scope !== "combined" && animation.properties.has(property),
          );
          if (!conflicts.length) continue;
          transform({
            filename: "position.css",
            code: Buffer.from(`${animation.selector}{}`),
            visitor: {
              Rule(rule) {
                if (rule.type === "style")
                  animations.push({
                    selectors: rule.value.selectors,
                    clip: conflicts.some(([, scope]) => scope === "clip"),
                  });
              },
            },
          });
        }
      } catch {
        reason ||=
          "Position is unavailable with custom or unrecognised animation scripts.";
      }
    }
    if (element.attrs.style) {
      let coordinates = false;
      let translate = false;
      try {
        transformStyleAttribute({
          code: Buffer.from(element.attrs.style),
          visitor: {
            Declaration(declaration) {
              coordinates ||= affectsCoordinates(declaration);
              translate ||= propertyOf(declaration) === "translate";
            },
          },
        });
      } catch {
        reason = "Position is unavailable with invalid styles.";
      }
      inline.set(element, { coordinates, translate });
    }
    if (element.tag === "style") {
      const css = parsed.html
        .slice(element.openEnd, element.end)
        .replace(/<\/style\s*>$/i, "");
      try {
        transform({
          filename: "position.css",
          code: Buffer.from(css),
          visitor: {
            Rule(rule) {
              if (rule.type === "import")
                reason = "Position is unavailable with external stylesheets.";
              if (rule.type === "keyframes")
                reason =
                  "Position is unavailable with CSS keyframe animations.";
              if (rule.type !== "style") return;
              const declarations = [
                ...rule.value.declarations.declarations,
                ...rule.value.declarations.importantDeclarations,
              ];
              if (declarations.some(affectsCoordinates))
                rules.push({
                  selectors: rule.value.selectors,
                  important: rule.value.declarations.importantDeclarations.some(
                    (d) => propertyOf(d) === "translate",
                  ),
                  translate: declarations.some(
                    (d) => propertyOf(d) === "translate",
                  ),
                });
            },
          },
        });
      } catch {
        reason = "Position is unavailable with invalid styles.";
      }
    }
  }
  const unsupported: Record<string, string> = {};
  for (const [id, element] of parsed.elements) {
    if (element.attrs.id !== id || ids.get(id) !== 1) {
      unsupported[id] = "Position requires a unique clip id in the source.";
      continue;
    }
    if (
      rules.some(
        (rule) =>
          rule.important &&
          rule.selectors.some((selector) => couldMatch(selector, element)),
      )
    ) {
      unsupported[id] = "Position is unavailable with important CSS translate.";
      continue;
    }
    if (reason) {
      unsupported[id] = reason;
      continue;
    }
    if (
      animations.some(
        (animation) =>
          animation.clip &&
          animation.selectors.some((selector) => couldMatch(selector, element)),
      )
    ) {
      unsupported[id] =
        "Position is unavailable with coordinate animations on this clip.";
      continue;
    }
    if (
      gsap &&
      (inline.get(element)?.translate ||
        rules.some(
          (rule) =>
            rule.translate &&
            rule.selectors.some((selector) => couldMatch(selector, element)),
        ))
    ) {
      unsupported[id] = "Position is unavailable with CSS translate and GSAP.";
      continue;
    }
    for (
      let parent = parents.get(element);
      parent;
      parent = parents.get(parent)
    ) {
      if (
        parent.attrs.transform !== undefined ||
        (parent.tag === "svg" && parent.attrs.viewBox !== undefined) ||
        inline.get(parent)?.coordinates ||
        animations.some((animation) =>
          animation.selectors.some((selector) => couldMatch(selector, parent)),
        ) ||
        rules.some((rule) =>
          rule.selectors.some((selector) => couldMatch(selector, parent)),
        )
      ) {
        unsupported[id] =
          "Position is unavailable inside a transformed container.";
        break;
      }
    }
  }
  return unsupported;
}
