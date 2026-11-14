import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const gsap = readFileSync(
  fileURLToPath(import.meta.resolve("gsap/dist/gsap.min.js")),
  "utf8",
);

/** The sole policy for live attribute updates, including script-free Cutroom titles.
 * Project markup cannot opt arbitrary scripts in.
 * Run on the compiler's source reads, before it adds its runtime and bootstrap scripts.
 */
export function previewTimingPolicy(dir: string) {
  let allowed = true;
  const root = realpathSync(dir);
  const read = (file: string) => {
    if (!allowed || !/\.html?$/i.test(file)) return;
    try {
      const path = realpathSync(file);
      const within = relative(root, path);
      if (within.startsWith("..") || isAbsolute(within)) {
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
                /^javascript:/i.test(value.replace(/[\u0000-\u0020]/g, "")),
            )
          )
            allowed = false;
          const scene = attrs.get("data-composition-src");
          if (scene && !/\.html?(?:[?#].*)?$/i.test(scene)) allowed = false;
          if (tag === "script") {
            const src = attrs.get("src");
            const inline = node.textContent?.trim();
            if (!src || inline || /^(?:[a-z]+:|\/\/)/i.test(src))
              allowed = false;
            else {
              // Only the actual pinned library is exempt, never a filename or authored marker.
              const local = resolve(dirname(path), src);
              const script = realpathSync(local);
              const relativeScript = relative(root, script);
              if (
                relativeScript.startsWith("..") ||
                isAbsolute(relativeScript) ||
                readFileSync(script, "utf8") !== gsap
              )
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
