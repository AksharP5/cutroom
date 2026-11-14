import { STUDIO_SIGNATURE_MANIFEST_PATHS } from "@hyperframes/studio-server";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse, serialize } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { parseFpsWithDefault } from "@hyperframes/core";
import { canonicalText } from "../../shared/timeline/schema";
import {
  declaredFonts,
  readTitle,
  titleAttributes,
  titleStyle,
} from "../timeline/titles";
import type { PreviewTiming } from "../../shared/preview";

/** Only these attributes are re-read by the pinned runtime's timing observer. */
const timingAttributes = [
  "data-start",
  "data-duration",
  "data-end",
  "data-media-start",
  "data-playback-start",
  "data-playback-rate",
] as const;

/** Validate the owned title contract before masking any saved values or generating CSS. */
function titleContract(
  document: DefaultTreeAdapterTypes.Document,
  html: string,
) {
  const references = html.replace(/\sdata-hf-id="[^"]*"/g, "");
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  const collect = (nodes: DefaultTreeAdapterTypes.ChildNode[]) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      elements.push(node);
      // Inert templates and mounted scenes are not part of the owned title contract.
      collect(node.childNodes);
    }
  };
  collect(document.childNodes);
  const attribute = (node: DefaultTreeAdapterTypes.Element, name: string) =>
    node.attrs.find((attr) => attr.name === name)?.value;
  const roots = elements.filter(
    (node) => attribute(node, "data-composition-id") !== undefined,
  );
  const titles = elements.filter(
    (node) => attribute(node, "data-cutroom-title") !== undefined,
  );
  const styles = elements.filter(
    (node) =>
      node.tagName === "style" &&
      attribute(node, "data-cutroom-titles") !== undefined,
  );
  const titleData = new Map<
    DefaultTreeAdapterTypes.Element,
    NonNullable<PreviewTiming["clips"][number]["title"]>
  >();
  let expectedStyle: string | null = null;
  if (roots.length === 1 && titles.length) {
    const fps = parseFpsWithDefault(attribute(roots[0]!, "data-fps"));
    const fonts = new Set(declaredFonts(html));
    const usedFonts = new Set<string>();
    for (const node of titles) {
      const attrs = Object.fromEntries(
        node.attrs.map(({ name, value }) => [name, value]),
      );
      const read = fps.ok && readTitle(attrs, fps.value, fonts);
      if (
        !read ||
        !("title" in read) ||
        attrs["data-cutroom-title"] !== "1" ||
        !attrs["data-hf-cutroom-clip-id"] ||
        attrs["data-composition-id"] !== undefined ||
        attrs["data-composition-src"] !== undefined ||
        node.childNodes.some(
          (child) =>
            child.nodeName !== "#text" &&
            !(
              "tagName" in child &&
              child.tagName === "br" &&
              child.attrs.every(
                ({ name, value }) =>
                  name === "data-hf-id" && !references.includes(value),
              )
            ),
        )
      )
        break;
      const text = node.childNodes.map((child) =>
        "value" in child
          ? child.value
          : {
              br:
                "attrs" in child
                  ? (child.attrs.find(({ name }) => name === "data-hf-id")
                      ?.value ?? null)
                  : null,
            },
      );
      if (
        !canonicalText(
          text.map((part) => (typeof part === "string" ? part : "\n")).join(""),
        )
      )
        break;
      if (read.title.font) usedFonts.add(read.title.font);
      // Keep the decoded strings from the actual saved/compiled document, including exact
      // seconds and text-node boundaries. Validation never regenerates or rounds a live value.
      titleData.set(node, {
        attributes: titleAttributes(read.title, fps.value)
          .filter(([name]) => name !== "data-cutroom-title")
          .map(([name]) => [name, attrs[name] ?? null]),
        text,
      });
    }
    if (titleData.size === titles.length) expectedStyle = titleStyle(usedFonts);
    else titleData.clear();
  }
  return { titleData, expectedStyle, styles, elements };
}

/** Compare the compiled document, including scripts, styles and nested compositions.
 * Only numeric timing and validated Cutroom title data on identified leaf clips may differ.
 */
export function previewTiming(html: string, dependencies = ""): PreviewTiming {
  const document = parse(html);
  const clips: PreviewTiming["clips"] = [];
  const { titleData, expectedStyle, styles, elements } = titleContract(
    document,
    html,
  );
  // The compiler may merge the owned rules into an adjacent stylesheet. Match only
  // the exact generated CSS, once, and retain everything around it in the structure hash.
  const css = expectedStyle
    ?.slice(expectedStyle.indexOf(">") + 1, -"</style>".length)
    .trim();
  const allStyles = elements.filter((node) => node.tagName === "style");
  const matches = css
    ? allStyles.filter((node) => serialize(node).includes(css))
    : [];
  const managedStyle = matches.length === 1 ? matches[0] : undefined;
  const content = managedStyle && serialize(managedStyle);
  const allowed = Boolean(
    css &&
    managedStyle &&
    content &&
    content.indexOf(css) === content.lastIndexOf(css) &&
    styles.length <= 1 &&
    (!styles.length || styles[0] === managedStyle) &&
    managedStyle.attrs.every(
      ({ name, value }) =>
        name === "data-cutroom-track-stacking" ||
        (name === "data-cutroom-titles" && value === "1"),
    ),
  );
  const sheet = allowed ? css! : null;
  if (!sheet) titleData.clear();
  // Generated HF ids include timing in their hash. Retain any id referenced by
  // scripts/CSS/markup; changing one of those must still reload the document.
  const references = html.replace(/\sdata-hf-id="[^"]*"/g, "");
  const visit = (nodes: DefaultTreeAdapterTypes.ChildNode[]) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
      const id = attrs.get("data-hf-cutroom-clip-id");
      if (
        id &&
        !attrs.has("data-composition-id") &&
        !attrs.has("data-composition-src")
      ) {
        const values = {
          "data-start": attrs.get("data-start") ?? null,
          "data-duration": attrs.get("data-duration") ?? null,
          "data-end": attrs.get("data-end") ?? null,
          "data-media-start": attrs.get("data-media-start") ?? null,
          "data-playback-start": attrs.get("data-playback-start") ?? null,
          "data-playback-rate": attrs.get("data-playback-rate") ?? null,
        };
        // References and malformed timing require the full runtime initialization path.
        if (
          Object.values(values).every(
            (value) =>
              value === null ||
              (value.trim() !== "" &&
                Number.isFinite(Number(value)) &&
                Number(value) >= 0),
          )
        ) {
          const title = titleData.get(node) ?? null;
          clips.push({ id, values, title });
          node.attrs = node.attrs.filter(
            ({ name }) =>
              !timingAttributes.some((attribute) => attribute === name) &&
              !title?.attributes.some(([attribute]) => attribute === name),
          );
          if (title) node.childNodes = [];
        }
      }
      if (sheet && node === managedStyle) {
        for (const child of node.childNodes)
          if ("value" in child) child.value = child.value.replace(sheet, "");
      }
      if (
        node.tagName === "meta" &&
        attrs.get("name") === "hyperframes-project-signature"
      )
        node.attrs = node.attrs.filter(({ name }) => name !== "content");
      const hfId = attrs.get("data-hf-id");
      if (hfId && !references.includes(hfId))
        node.attrs = node.attrs.filter(({ name }) => name !== "data-hf-id");
      if (node.tagName === "head")
        node.childNodes = node.childNodes.filter(
          (child) =>
            !(
              "value" in child &&
              child.nodeName === "#text" &&
              !child.value.trim()
            ),
        );
      // Attribute insertion/order and whitespace around an attribute are not structure.
      node.attrs.sort((a, b) => a.name.localeCompare(b.name));
      visit(node.childNodes);
      if ("content" in node) visit(node.content.childNodes);
    }
  };
  visit(document.childNodes);
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const structure = hash(dependencies + serialize(document));

  return {
    structure,
    revision: hash(structure + JSON.stringify(clips) + JSON.stringify(sheet)),
    clips,
    titleStyle: sheet,
  };
}

/** App state/history must not invalidate timing; every other project file does.
 * An unavailable fingerprint disables live timing without blocking a full preview.
 */
export async function previewDependencies(dir: string, composition: string) {
  const hash = createHash("sha256");
  const visit = async (relative: string) => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "renders"].includes(entry.name)
      )
        continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (path === composition || path === "cutroom.json") continue;
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const file = Bun.file(join(dir, path));
      const info = await file.stat();
      hash.update(path + "\0" + info.size + "\0");
      if (
        /\.(html?|css|m?[jt]sx?|json|svg|srt|vtt)$/i.test(path) &&
        info.size <= 2_000_000
      )
        hash.update(await readFile(join(dir, path)));
      else
        hash.update(`${info.mtimeMs}:${info.ctimeMs}:${info.ino}:${info.dev}`);
    }
  };
  try {
    await visit("");
    // These hidden manifests affect compiled animation and are not ordinary app state.
    for (const path of STUDIO_SIGNATURE_MANIFEST_PATHS) {
      const info = await lstat(join(dir, path)).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      });
      if (info?.isFile())
        hash.update(path + "\0" + (await readFile(join(dir, path), "utf8")));
    }
    return hash.digest("hex");
  } catch (error) {
    console.warn(
      "Preview timing fingerprint unavailable; using document reload.",
      error,
    );
    return null;
  }
}
