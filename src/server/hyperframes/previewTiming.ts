import { STUDIO_SIGNATURE_MANIFEST_PATHS } from "@hyperframes/studio-server";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse, serialize } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
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

/** Compare the compiled document, including scripts, styles and nested compositions.
 * Only numeric timing on identified leaf clips may differ. Root/nested timing reloads.
 */
export function previewTiming(html: string, dependencies = ""): PreviewTiming {
  const document = parse(html);
  const clips: PreviewTiming["clips"] = [];
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
          clips.push({ id, values });
          node.attrs = node.attrs.filter(
            ({ name }) =>
              !timingAttributes.some((attribute) => attribute === name),
          );
        }
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
    revision: hash(structure + JSON.stringify(clips)),
    clips,
  };
}

/** App state/history must not invalidate timing; every other project file does. */
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
  await visit("");
  // These hidden manifests affect compiled animation and are not ordinary app state.
  for (const path of STUDIO_SIGNATURE_MANIFEST_PATHS) {
    const info = await lstat(join(dir, path)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });
    if (info?.isFile())
      hash.update(path + "\0" + (await readFile(join(dir, path), "utf8")));
  }
  return hash.digest("hex");
}
