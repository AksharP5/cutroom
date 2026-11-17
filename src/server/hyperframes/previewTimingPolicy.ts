import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const gsap = readFileSync(
  fileURLToPath(import.meta.resolve("gsap/dist/gsap.min.js")),
  "utf8",
);

/** Cutroom's own state: media caches, review and view state, attachments, exports. */
export const APP_STATE_DIR = ".cutroom";

/**
 * Known script reads that depend on live edits. Matching scripts keep the full reload path;
 * selector dependencies are checked in the page. This scan is not general JavaScript
 * dependency analysis.
 */
const liveInputs = [
  /\bgetAttribute/,
  /\b(?:attributes|dataset|outerHTML|getHTML|textContent|innerText|outerText|XMLSerializer)\b/,
  // Assigning markup writes it; reading or appending to it reads it.
  /\binnerHTML\b(?!\s*=[^=])/,
  /data-(?:start|duration|end|media-start|playback|volume|title|cutroom|hf-)/,
  /\b(?:children|childNodes|childElementCount|(?:first|last)(?:Element)?Child|(?:next|previous)(?:Element)?Sibling)\b/,
  /\b(?:createTreeWalker|createNodeIterator|elementsFromPoint|elementFromPoint)\b/,
  /\bdocument\s*\.\s*(?:all|images|links|forms|embeds|plugins|scripts|anchors)\b/,
  /\b(?:currentTime|playbackRate|getComputedStyle|checkVisibility)\b/,
  /\b(?:MutationObserver|IntersectionObserver)\b/,
  /\b(?:eval|Function|import)\b/,
  /\b(?:postMessage|onmessage|MessageChannel|BroadcastChannel)\b|["'`]message["'`]/,
  /\b__(?:player|hf\w*|clipManifest)\b/,
];

/** Whether a script uses a known read of data changed by live edits. */
export function readsLiveInputs(script: string) {
  return liveInputs.some((pattern) => pattern.test(script));
}

/** The sole policy for live attribute updates, including script-free Cutroom titles.
 * Inline scripts with known live reads reload; script files qualify only when they are the
 * pinned GSAP library. Run on the compiler's source reads, before it adds runtime scripts.
 */
export function previewTimingPolicy(dir: string) {
  let allowed = true;
  const root = realpathSync(dir);
  // The preview signature does not cover app state, so a compile must not read source from it.
  const unsigned = (path: string) => {
    const within = relative(root, path);
    return (
      within.startsWith("..") ||
      isAbsolute(within) ||
      within.split(sep)[0] === APP_STATE_DIR
    );
  };
  const read = (file: string) => {
    if (!allowed || !/\.html?$/i.test(file)) return;
    try {
      const path = realpathSync(file);
      if (unsigned(path)) {
        allowed = false;
        return;
      }
      const visit = (parent: ParentNode) => {
        for (const node of parent.children) {
          const tag = node.localName.toLowerCase();
          const attrs = new Map(
            Array.from(node.attributes, ({ name, value }) => [
              name.toLowerCase(),
              value,
            ]),
          );
          if (
            ["iframe", "object", "embed"].includes(tag) ||
            (tag === "meta" &&
              attrs.get("http-equiv")?.toLowerCase() === "refresh") ||
            [...attrs].some(
              ([name, value]) =>
                name.startsWith("on") ||
                name === "srcdoc" ||
                /^javascript:/i.test(value.replace(/[\u0000- ]/g, "")),
            )
          )
            allowed = false;
          const scene = attrs.get("data-composition-src");
          if (scene && !/\.html?(?:[?#].*)?$/i.test(scene)) allowed = false;
          if (tag === "script") {
            const src = attrs.get("src");
            const inline = node.textContent ?? "";
            if (attrs.has("data-hyperframes-preview-runtime")) allowed = false;
            else if (src === undefined) {
              if (readsLiveInputs(inline)) allowed = false;
            } else if (inline.trim() || /^(?:[a-z]+:|\/\/)/i.test(src))
              allowed = false;
            else {
              // Only the actual pinned library is exempt, never a filename or authored marker.
              const local = resolve(dirname(path), src);
              const script = realpathSync(local);
              if (unsigned(script) || readFileSync(script, "utf8") !== gsap)
                allowed = false;
            }
          }
          visit(node);
          if (tag === "template") visit((node as HTMLTemplateElement).content);
        }
      };
      // Use the compiler's parser: it can hoist scripts from fallback tags that
      // a browser parser treats as inert text. Inspect template contents too.
      visit(parseHTML(readFileSync(path, "utf8")).document);
    } catch {
      allowed = false;
    }
  };
  return { read, contract: () => (allowed ? ("attributes" as const) : null) };
}
