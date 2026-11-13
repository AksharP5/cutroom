import {
  parseGsapScriptAcorn,
  parseGsapScriptAcornForWrite,
} from "@hyperframes/parsers/gsap-parser-acorn";
import { simple } from "acorn-walk";
import type { Expression, MemberExpression, Super } from "acorn";
import { parseHTML } from "linkedom";
import { canonicalSeconds } from "../../shared/timeline/apply";
import type { ClipOrigin } from "../../shared/timeline/apply";
import { clipName } from "../../shared/timeline/labels";
import type { AnimationLeftBehind, Clip } from "../../shared/timeline/schema";
import type { ParsedComposition } from "./composition";

/** Inspect authored animation only. Nothing returned here can change a script. */
export async function animationFeedback(
  before: ParsedComposition,
  after: ParsedComposition,
  shifts: ReadonlyMap<string, number>,
  origins: ReadonlyMap<string, ClipOrigin>,
  snapshots: ReadonlyMap<string, ParsedComposition>,
  readExternal: (src: string) => Promise<string | null>,
): Promise<AnimationLeftBehind[]> {
  const previous = new Map(
    before.timeline.clips.map((clip) => [clip.id, clip]),
  );
  type Candidate = { clip: Clip; sourceId: string };
  const contexts = new Map<ParsedComposition, Candidate[]>();
  const add = (source: ParsedComposition, candidate: Candidate) => {
    const candidates = contexts.get(source) ?? [];
    candidates.push(candidate);
    contexts.set(source, candidates);
  };
  for (const clip of after.timeline.clips) {
    const attrs = after.elements.get(clip.id)?.attrs;
    if (
      clip.kind === "composition" ||
      attrs?.["data-composition-id"] !== undefined ||
      attrs?.["data-composition-src"] !== undefined
    )
      continue;
    const old = previous.get(clip.id);
    if (old && !canonicalSeconds(shifts.get(clip.id) ?? 0)) continue;
    const origin = origins.get(clip.id);
    if (old) add(before, { clip, sourceId: old.id });
    else if (origin && "copyOf" in origin) {
      const source = previous.get(origin.copyOf);
      if (source) add(before, { clip, sourceId: source.id });
    } else if (origin && "clipboardId" in origin) {
      const snapshot = snapshots.get(origin.clipboardId)!;
      const source = snapshot.timeline.clips.find(
        (item) => item.id === origin.clipId,
      )!;
      add(snapshot, { clip, sourceId: source.id });
    }
    // A new element or pasted program can introduce an animation match after the edit too.
    add(after, {
      clip,
      sourceId: clip.id,
    });
  }
  const warnings = new Map<string, AnimationLeftBehind>();
  const parsedScripts = new Map<
    string,
    ReturnType<typeof parseGsapScriptAcorn>
  >();
  const external = new Map<string, Promise<string | null>>();
  const gsapCall =
    /\bgsap\s*(?:\.\s*(?:timeline|to|from|fromTo|set)|\[\s*["'](?:timeline|to|from|fromTo|set)["']\s*\])\s*\(/;
  const tweenCall =
    /(?:\.\s*(?:to|from|fromTo|set)|\[\s*["'](?:to|from|fromTo|set)["']\s*\])\s*\(/;
  for (const [source, candidates] of contexts) {
    const pending = candidates.filter(({ clip }) => !warnings.has(clip.id));
    if (!pending.length || !/<script\b/i.test(source.html)) continue;
    const { document } = parseHTML(source.html);
    const root =
      source.scope === "sub-composition"
        ? (document.querySelector("template") ?? document)
        : document;
    const ids = new Map<string, Element[]>();
    for (const node of root.querySelectorAll("[id]")) {
      const id = node.id.toLowerCase();
      ids.set(id, [...(ids.get(id) ?? []), node]);
    }
    const owners = new Map<Element, Candidate[]>();
    const hints = new Map<Candidate, RegExp>();
    for (const candidate of pending) {
      const element = source.elements.get(candidate.sourceId);
      if (!element) continue;
      const authored = element.attrs.id;
      const nodes = authored
        ? (ids.get(authored.toLowerCase()) ?? [])
        : Array.from(root.querySelectorAll("[data-start]")).filter(
            (node) =>
              !node.id &&
              node.tagName.toLowerCase() === element.tag &&
              ["data-start", "data-duration", "data-track-index", "src"].every(
                (name) =>
                  (node.getAttribute(name) ?? undefined) ===
                  element.attrs[name],
              ),
          );
      const tokens = new Set<string>();
      for (const node of nodes) {
        owners.set(node, [...(owners.get(node) ?? []), candidate]);
        for (const descendant of [
          node,
          ...node.querySelectorAll("[id], [class]"),
        ]) {
          if (descendant.id) tokens.add(`#${descendant.id}`);
          for (const name of (descendant.getAttribute("class") ?? "").split(
            /[\t\n\f\r ]+/,
          ))
            if (name) tokens.add(`.${name}`);
        }
      }
      const escape = (text: string) =>
        text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const selectors = [...tokens].map(
        (token) => `${escape(token)}(?![\\w-])`,
      );
      if (authored) selectors.push(`["'\x60]${escape(authored)}["'\x60]`);
      if (selectors.length)
        hints.set(candidate, new RegExp(selectors.join("|"), "i"));
    }
    const scriptNodes = Array.from(root.querySelectorAll("script")).filter(
      (node) => {
        const host = node.closest("[data-composition-id]");
        return (
          !host ||
          host.getAttribute("data-composition-id") ===
            source.root.attrs["data-composition-id"]
        );
      },
    );
    const scripts = await Promise.all(
      scriptNodes.map(async (node) => {
        const src = node.getAttribute("src");
        if (!src) return node.textContent ?? "";
        if (!external.has(src)) external.set(src, readExternal(src));
        return (await external.get(src)) ?? "";
      }),
    );
    const animations: ReturnType<typeof parseGsapScriptAcorn>["animations"] =
      [];
    const parseScript = (text: string) => {
      if (!text) return;
      if (!parsedScripts.has(text))
        parsedScripts.set(text, parseGsapScriptAcorn(text));
      const parsed = parsedScripts.get(text)!;
      animations.push(
        ...parsed.animations.filter((animation) => !animation.global),
      );
      if (
        parsed.multipleTimelines &&
        parsed.postamble &&
        parsed.postamble.length < text.length
      )
        parseScript(parsed.postamble);
    };
    const inspected: string[] = [];
    for (const [index, text] of scripts.entries())
      if (
        !scriptNodes[index].hasAttribute("src") ||
        gsapCall.test(text) ||
        [...hints.values()].some((hint) => hint.test(text))
      ) {
        inspected.push(text);
        parseScript(text);
      }
    const hasTweens =
      animations.length > 0 ||
      (scripts.some((text) => gsapCall.test(text)) &&
        scripts.some((text) => tweenCall.test(text)));
    if (!hasTweens) continue;
    const matched = new Set<Candidate>();
    const targets = new Map<string, Element[]>();
    let dynamic = false;
    const match = (selector: string) => {
      if (!targets.has(selector)) {
        const direct = /^#([\w-]+)$/.exec(selector);
        try {
          targets.set(
            selector,
            direct
              ? (ids.get(direct[1].toLowerCase()) ?? [])
              : Array.from(root.querySelectorAll(selector)),
          );
        } catch {
          targets.set(selector, []);
        }
      }
      for (const target of targets.get(selector)!)
        for (let node: Element | null = target; node; node = node.parentElement)
          for (const candidate of owners.get(node) ?? [])
            matched.add(candidate);
    };
    for (const animation of animations) {
      const selector = animation.targetSelector;
      match(selector);
      // A compiler-created media id is absent from authored DOM, so prefer a nudge to silence.
      if (
        !targets.get(selector)!.length &&
        /#hf-(?:video|audio)-\d+/.test(selector)
      )
        dynamic = true;
    }
    // The upstream inspector does not expand every receiver form. Inspect unmatched targets
    // as whole literals; only expression targets may use loose source references.
    const loose: string[] = [];
    if (pending.some((candidate) => !matched.has(candidate))) {
      const parsed = inspected.map((text) => ({
        text,
        tree: parseGsapScriptAcornForWrite(text),
      }));
      const timelines = new Set<string>();
      const memberName = (node: MemberExpression) =>
        !node.computed && node.property.type === "Identifier"
          ? node.property.name
          : node.computed &&
              node.property.type === "Literal" &&
              typeof node.property.value === "string"
            ? node.property.value
            : null;
      const receiver = (node: Expression | Super): boolean => {
        if (node.type === "Identifier")
          return node.name === "gsap" || timelines.has(node.name);
        if (node.type === "MemberExpression")
          return (
            (node.object.type === "Identifier" &&
              node.object.name === "window" &&
              memberName(node) === "gsap") ||
            (node.object.type === "MemberExpression" &&
              memberName(node.object) === "__timelines")
          );
        if (
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression"
        )
          return receiver(node.callee.object);
        return false;
      };
      // Timeline declarations can be in an earlier inline or local script.
      for (const { tree } of parsed) {
        if (!tree) continue;
        simple(tree.ast, {
          VariableDeclarator(node) {
            if (
              node.id.type === "Identifier" &&
              node.init &&
              receiver(node.init)
            )
              timelines.add(node.id.name);
          },
          AssignmentExpression(node) {
            if (node.left.type === "Identifier" && receiver(node.right))
              timelines.add(node.left.name);
          },
        });
      }
      for (const { text, tree } of parsed) {
        if (!tree) continue;
        const literals = new Map<string, string>();
        simple(tree.ast, {
          VariableDeclaration(node) {
            if (node.kind !== "const") return;
            for (const declaration of node.declarations)
              if (
                declaration.id.type === "Identifier" &&
                declaration.init?.type === "Literal" &&
                typeof declaration.init.value === "string"
              )
                literals.set(declaration.id.name, declaration.init.value);
          },
        });
        let unresolvedTarget = false;
        const masked: { start: number; end: number }[] = [];
        simple(tree.ast, {
          TemplateLiteral(node) {
            if (!node.expressions.length) masked.push(node);
          },
          Literal(node) {
            if (typeof node.value === "string" && /[#.]/.test(node.value))
              masked.push(node);
          },
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type !== "MemberExpression" ||
              !["to", "from", "fromTo", "set"].includes(
                memberName(callee) ?? "",
              ) ||
              !receiver(callee.object)
            )
              return;
            const target = node.arguments[0];
            const selector =
              target?.type === "Literal" && typeof target.value === "string"
                ? target.value
                : target?.type === "TemplateLiteral" &&
                    !target.expressions.length
                  ? target.quasis[0].value.cooked
                  : target?.type === "Identifier"
                    ? literals.get(target.name)
                    : null;
            if (typeof selector === "string") match(selector);
            else {
              unresolvedTarget = true;
            }
          },
        });
        if (
          unresolvedTarget &&
          animations.some((animation) => animation.hasUnresolvedSelector)
        )
          dynamic = true;
        if (unresolvedTarget) {
          let code = text;
          for (const span of masked.toSorted((a, b) => b.start - a.start))
            code =
              code.slice(0, span.start) +
              " ".repeat(span.end - span.start) +
              code.slice(span.end);
          loose.push(code);
        }
      }
    }
    for (const candidate of pending) {
      if (
        !matched.has(candidate) &&
        !dynamic &&
        !loose.some((text) => hints.get(candidate)?.test(text))
      )
        continue;
      warnings.set(candidate.clip.id, {
        clipId: candidate.clip.id,
        label: clipName(candidate.clip),
      });
    }
  }
  return [...warnings.values()];
}
