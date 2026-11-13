import { posix } from "node:path";
import {
  decodeAuthoredAttribute,
  encodeUrlPath,
  scanHtmlOpeningTags,
} from "@hyperframes/parsers";
import { CSS_URL_RE, decodeCssEscapes } from "@hyperframes/parsers/asset-paths";
import { localMediaPath } from "../../shared/media";

/** Rewrite only paths that resolve to the renamed file, retaining their relative prefix. */
export function renameReferences(
  source: string,
  file: string,
  from: string,
  to: string,
  files: Set<string>,
) {
  const path = (value: string, url: boolean) => {
    const local = localMediaPath(file, value);
    if (local === null) return value;
    // Registry sources may name a project-root asset when no sibling exists.
    const resolved =
      files.has(local) || /^[./]/.test(value)
        ? local
        : localMediaPath("index.html", value);
    if (resolved !== from) return value;
    const pathname = value.split(/[?#]/, 1)[0]!;
    const name = posix.basename(to);
    const replacement =
      /%[\da-f]{2}/i.test(pathname) || url
        ? encodeUrlPath(name)
        : name.replace(/[%?#]/g, encodeURIComponent);
    return (
      pathname.slice(0, pathname.lastIndexOf("/") + 1) +
      replacement +
      value.slice(pathname.length)
    );
  };
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
