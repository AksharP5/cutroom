import { parse, defaultTreeAdapter } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { localMediaPath } from "../../shared/media";
import type { Project } from "../../shared/project";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import { activeVersion } from "../../shared/timeline/versions";
import { readSource } from "../projects/store";
import {
  attributeMarkup,
  compositionScope,
  parseComposition,
} from "../timeline/composition";
import type { AttributeChange } from "../timeline/composition";
import { VERSIONS_ATTRIBUTE } from "../timeline/versions";

/** The preview query naming the clip whose versions a document carries, for instant switching. */
export const AUDITION_PARAM = "cutroom-audition";
/** What the editor posts to an audition document to show one version, by its index. */
export const AUDITION_MESSAGE = "cutroom-audition";

/** Host attributes a standby copy does not take from the clip: they name the clip or its file. */
const OWN_ATTRIBUTES = new Set([
  "id",
  "src",
  "data-composition-src",
  "data-composition-id",
  "data-width",
  "data-height",
  "data-hf-id",
  "data-link",
  "data-label",
  "data-timeline-label",
  VERSIONS_ATTRIBUTE,
]);

/*
 * Every host carries its version's index; only the one marked shown draws. The runtime may set
 * a clip's own visibility inline, so the rule also reaches every descendant, and opacity covers
 * descendants an animation makes visible again.
 */
const AUDITION_STYLE = `<style data-cutroom-audition>[data-cutroom-version]:not([data-cutroom-shown]),[data-cutroom-version]:not([data-cutroom-shown]) *{visibility:hidden!important;opacity:0!important;pointer-events:none!important}</style>`;
const AUDITION_SCRIPT = `<script data-cutroom-audition>addEventListener("message",(event)=>{if(event.source!==parent)return;const data=event.data;if(!data||data.source!==${JSON.stringify(AUDITION_MESSAGE)}||!Number.isInteger(data.version))return;const hosts=document.querySelectorAll("[data-cutroom-version]");if(![...hosts].some((host)=>host.getAttribute("data-cutroom-version")===String(data.version)))return;for(const host of hosts){const shown=host.getAttribute("data-cutroom-version")===String(data.version);host.toggleAttribute("data-cutroom-shown",shown);for(const media of host.querySelectorAll("video,audio"))media.muted=!shown||media.hasAttribute("muted");}requestAnimationFrame(()=>parent.postMessage({source:${JSON.stringify(AUDITION_MESSAGE)},shown:data.version},"*"));});</script>`;

type Element = DefaultTreeAdapterTypes.Element;

/** The first live element in tree order that matches. */
function find(
  nodes: DefaultTreeAdapterTypes.ChildNode[],
  matches: (element: Element) => boolean,
) {
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.shift()!;
    if (!defaultTreeAdapter.isElementNode(node)) continue;
    if (matches(node)) return node;
    stack.unshift(...node.childNodes);
  }
  return null;
}
const findById = (nodes: DefaultTreeAdapterTypes.ChildNode[], id: string) =>
  find(nodes, (node) =>
    node.attrs.some(({ name, value }) => name === "id" && value === id),
  );
const findByName = (nodes: DefaultTreeAdapterTypes.ChildNode[], name: string) =>
  find(nodes, (node) => node.nodeName === name);

/**
 * A preview document that carries every version of one clip, so the editor can show any of
 * them within a frame. The active version stays as the compiler built it, so it draws exactly
 * as export does; each other version is a hidden copy of the clip's host that the runtime loads
 * from its file. Returns the document unchanged when the clip has no versions to add.
 */
export async function auditionDocument(
  html: string,
  project: Project,
  composition: string,
  clipId: string,
): Promise<string> {
  const source = await readSource(project, composition);
  const parsed = parseComposition(source.content, emptyTimelineSettings(), {
    scope: compositionScope(composition),
  });
  const clip = parsed.timeline.clips.find(({ id }) => id === clipId);
  const element = parsed.elements.get(clipId);
  if (!clip?.versions || !element) return html;
  const active = activeVersion(clip);
  const standby: string[] = [];
  for (const [index, version] of clip.versions.entries()) {
    if (index === active) continue;
    // The document's base is the project folder, so a version is written from there.
    const path = localMediaPath(composition, version.src);
    if (
      path === null ||
      path.startsWith("../") ||
      path.split("/").some((part) => part.startsWith("."))
    )
      continue;
    const kept = Object.entries(element.attrs).filter(
      ([name]) => !OWN_ATTRIBUTES.has(name),
    );
    const own: AttributeChange[] = [
      ["id", `cutroom-version-${clipId}-${index}`],
      ["data-cutroom-version", String(index)],
    ];
    if (clip.kind === "image") {
      standby.push(`<img${attributeMarkup([...own, ["src", path], ...kept])}>`);
      continue;
    }
    const scene = await readSource(project, path).then(
      (file) =>
        parseComposition(file.content, emptyTimelineSettings(), {
          scope: compositionScope(path),
        }).root.attrs,
      () => null,
    );
    const id = scene?.["data-composition-id"];
    if (!scene || !id) continue;
    standby.push(
      `<div${attributeMarkup([
        ...own,
        ["data-composition-src", path],
        ["data-composition-id", id],
        ...(scene["data-width"]
          ? [["data-width", scene["data-width"]] as const]
          : []),
        ...(scene["data-height"]
          ? [["data-height", scene["data-height"]] as const]
          : []),
        ...kept,
      ])}></div>`,
    );
  }
  if (!standby.length) return html;
  const document = parse(html, { sourceCodeLocationInfo: true });
  const host = findById(document.childNodes, clipId);
  const head = findByName(document.childNodes, "head")?.sourceCodeLocation;
  const location = host?.sourceCodeLocation;
  if (!location?.startTag || !head?.endTag) return html;
  const { endOffset } = location.startTag;
  const tagEnd = html[endOffset - 2] === "/" ? endOffset - 2 : endOffset - 1;
  // The other versions follow the clip in its own parent, so they share its containing block.
  return (
    html.slice(0, head.endTag.startOffset) +
    AUDITION_STYLE +
    AUDITION_SCRIPT +
    html.slice(head.endTag.startOffset, tagEnd) +
    ` data-cutroom-version="${active}" data-cutroom-shown` +
    html.slice(tagEnd, location.endOffset) +
    standby.join("") +
    html.slice(location.endOffset)
  );
}
