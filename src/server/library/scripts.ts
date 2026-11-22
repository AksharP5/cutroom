import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceUrl } from "../../shared/media";

/** Where Cutroom projects keep GSAP and its plugins, which preview and export load offline. */
export const PROJECT_VENDOR = "assets/vendor";

/** The pinned GSAP build's own files: its core and every plugin it ships. */
export const gsapDist = dirname(
  fileURLToPath(import.meta.resolve("gsap/dist/gsap.min.js")),
);

/** GSAP from the CDN registry items use, which a project can load from its own copy instead. */
const CDN_GSAP =
  /(["'])https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@[\d.]+\/dist\/([A-Za-z0-9]+(?:\.min)?\.js)\1/g;

const vendorable = (file: string) => existsSync(join(gsapDist, file));

/**
 * The network URLs an item's HTML, CSS or script would load: scripts, stylesheets, imports,
 * fonts and fetched data. GSAP's own files are left out, since they are copied into the project.
 * Cutroom's preview sandbox and renderer cannot reach any of the rest.
 */
export function onlineReferences(text: string) {
  const patterns = [
    /<script\b[^>]*\bsrc\s*=\s*["']((?:https?:)?\/\/[^"']+)/gi,
    /@import\s+(?:url\(\s*)?["']?((?:https?:)?\/\/[^"')\s;]+)/gi,
    /\burl\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi,
    /\bfrom\s+["']((?:https?:)?\/\/[^"']+)/g,
    /\bimport\(\s*["']((?:https?:)?\/\/[^"']+)/g,
    /\bfetch\(\s*["']((?:https?:)?\/\/[^"']+)/g,
  ];
  const links = [...text.matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => !/\brel\s*=\s*["']?(?:preconnect|dns-prefetch)/i.test(tag))
    .flatMap(
      (tag) =>
        /\bhref\s*=\s*["']((?:https?:)?\/\/[^"']+)/i.exec(tag)?.[1] ?? [],
    );
  return [
    ...new Set([
      ...patterns.flatMap((pattern) =>
        [...text.matchAll(pattern)].map((match) => match[1]!),
      ),
      ...links,
    ]),
  ].filter((url) => {
    const gsap =
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@[\d.]+\/dist\/([A-Za-z0-9]+(?:\.min)?\.js)$/.exec(
        url,
      );
    return !(gsap && vendorable(gsap[1]!));
  });
}

/** An item's HTML with GSAP and its plugins loaded from the project's own copies, and which. */
export function withProjectScripts(html: string, path: string) {
  const vendored = new Set<string>();
  const rewritten = html.replace(
    CDN_GSAP,
    (match, quote: string, file: string) => {
      if (!vendorable(file)) return match;
      vendored.add(file);
      return `${quote}${sourceUrl(path, `${PROJECT_VENDOR}/${file}`)}${quote}`;
    },
  );
  return { html: rewritten, vendored };
}
