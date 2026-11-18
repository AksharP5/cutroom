import { posix } from "node:path";
import {
  decodeAuthoredAttribute,
  encodeUrlPath,
  scanHtmlOpeningTags,
} from "@hyperframes/parsers";
import { CSS_URL_RE, decodeCssEscapes } from "@hyperframes/parsers/asset-paths";
import { localMediaPath, sourceUrl } from "../../shared/media";
import type { Project } from "../../shared/project";
import { rewriteImageDeclarationUrls } from "../../shared/variables";
import { canonicalAssetPath } from "./path";

export type ProjectEntry = "file" | "directory" | "unscanned";

/** Rewrite URLs while the files and their aliases still resolve to the original targets. */
export function mediaReferenceRenamer(
  project: Project,
  names: ReadonlyMap<string, string>,
  entries: ReadonlyMap<string, ProjectEntry>,
) {
  const paths = new Map<string, Promise<string | null>>();
  const resolve = (path: string) => {
    const entry = entries.get(path);
    if (entry === "file" || entry === "directory") return Promise.resolve(path);
    if (entry === undefined && entries.get(posix.dirname(path)) === "directory")
      return Promise.resolve(null);
    const cached = paths.get(path);
    if (cached) return cached;
    const pending = canonicalAssetPath(project, path).catch(
      (error: unknown) => {
        // Arbitrary strings in scripts and attributes can look like local paths.
        if (
          error instanceof Error &&
          "code" in error &&
          ["ENOTDIR", "ENAMETOOLONG", "ELOOP"].includes(String(error.code))
        )
          return null;
        throw error;
      },
    );
    paths.set(path, pending);
    return pending;
  };

  return async (source: string, file: string) => {
    const values = new Set<string>();
    mapReferences(source, file, (value) => {
      values.add(value);
      return value;
    });
    const replacements = new Map<
      string,
      { path: string; keepPrefix: boolean }
    >();
    await Promise.all(
      [...values].map(async (value) => {
        let reference = localMediaPath(file, value);
        if (!reference || reference === "." || reference.includes("\0")) return;
        let canonical = await resolve(reference);
        // Registry sources may name a project-root asset when no sibling exists.
        if (canonical === null && !/^[./]/.test(value)) {
          reference = localMediaPath("index.html", value);
          if (reference === null) return;
          canonical = await resolve(reference);
        }
        if (canonical === null) return;
        const path = names.get(canonical);
        if (path === undefined) return;
        replacements.set(value, {
          path,
          keepPrefix:
            reference === canonical ||
            (await resolve(posix.dirname(reference))) === posix.dirname(path),
        });
      }),
    );
    if (!replacements.size) return source;
    return mapReferences(source, file, (value, url) => {
      const target = replacements.get(value);
      if (!target) return value;
      const pathname = value.split(/[?#]/, 1)[0]!;
      const name = posix.basename(target.path);
      const replacement = target.keepPrefix
        ? pathname.slice(0, pathname.lastIndexOf("/") + 1) +
          (/%[\da-f]{2}/i.test(pathname) || url
            ? encodeUrlPath(name)
            : name.replace(/[%?#]/g, encodeURIComponent))
        : sourceUrl(file, target.path);
      return replacement + value.slice(pathname.length);
    });
  };
}

function mapReferences(
  source: string,
  file: string,
  path: (value: string, url: boolean) => string,
) {
  const css = (text: string) =>
    text.replace(CSS_URL_RE, (whole: string, _quote: string, raw: string) => {
      const value = decodeCssEscapes(raw);
      const next = path(value, true);
      return next === value ? whole : whole.replace(raw, next);
    });
  const script = (text: string) =>
    text.replace(
      /(["'`])((?:\\[^\r\n]|(?!\1)[^\\\r\n])*?)\1/g,
      (whole: string, quote: string, raw: string) => {
        const value = raw.replace(
          /\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|(.))/gi,
          (
            _: string,
            wide: string | undefined,
            unicode: string | undefined,
            hex: string | undefined,
            char: string | undefined,
          ) => {
            const code = wide ?? unicode ?? hex;
            if (code !== undefined) {
              const point = parseInt(code, 16);
              return point <= 0x10ffff ? String.fromCodePoint(point) : _;
            }
            const escapes: Record<string, string> = {
              n: "\n",
              r: "\r",
              t: "\t",
              b: "\b",
              f: "\f",
              v: "\v",
              "0": "\0",
            };
            return escapes[char ?? ""] ?? char ?? "";
          },
        );
        const next = path(value, false);
        if (next === value) return whole;
        const escaped = next
          .replace(/\\/g, "\\\\")
          .replace(/\r/g, "\\r")
          .replace(/\n/g, "\\n")
          .replaceAll(quote, `\\${quote}`);
        return (
          quote +
          (quote === "`" ? escaped.replaceAll("${", "\\${") : escaped) +
          quote
        );
      },
    );
  if (/\.css$/i.test(file)) return css(source);
  if (!/\.(?:html?|svg)$/i.test(file)) return script(source);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const tag of scanHtmlOpeningTags(source)) {
    for (const attr of tag.attributes) {
      if (attr.kind !== "value") continue;
      const value = decodeAuthoredAttribute(attr.value);
      const next =
        attr.name === "style"
          ? css(value)
          : attr.name === "data-composition-variables"
            ? rewriteImageDeclarationUrls(value, (url) => path(url, true))
            : attr.name === "srcset"
              ? value.replace(
                  /(^|,)\s*([^,\s]+)/g,
                  (whole: string, _lead: string, url: string) =>
                    whole.replace(url, path(url, true)),
                )
              : path(value, !attr.quote);
      if (next === value) continue;
      const escaped = next
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
      edits.push({
        start: attr.valueStart,
        end: attr.valueEnd,
        text: attr.quote
          ? escaped
          : escaped.replace(/[\s=<>`]/g, (char) => `&#${char.codePointAt(0)};`),
      });
    }
    if (tag.rawTextEnd === null || !["script", "style"].includes(tag.name))
      continue;
    const text = source.slice(tag.end, tag.rawTextEnd);
    const next = tag.name === "style" ? css(text) : script(text);
    if (next !== text)
      edits.push({ start: tag.end, end: tag.rawTextEnd, text: next });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
