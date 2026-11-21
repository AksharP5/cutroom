import { parse, defaultTreeAdapter } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { localMediaPath } from "../../shared/media";
import type { Project } from "../../shared/project";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import {
  activeVersion,
  mediaVersions,
  nextAudition,
  versionPartners,
  versionStart,
} from "../../shared/timeline/versions";
import { elementBounds, sourceAtEdge } from "../../shared/timeline/clipTiming";
import { frames } from "../../shared/timeline/piece";
import { compositionMediaFacts } from "../timeline/media";
import { readSource } from "../projects/store";
import {
  attributeMarkup,
  compositionScope,
  parseComposition,
} from "../timeline/composition";
import type { AttributeChange } from "../timeline/composition";
import {
  VERSION_INDEX_ATTRIBUTE,
  VERSION_SILENT_ATTRIBUTE,
  VERSIONS_ATTRIBUTE,
} from "../timeline/versions";

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
  VERSION_INDEX_ATTRIBUTE,
  VERSION_SILENT_ATTRIBUTE,
]);

/*
 * Every host carries its version's index; only the one marked shown draws. The runtime may set
 * a clip's own visibility inline, so the rule also reaches every descendant, and opacity covers
 * descendants an animation makes visible again.
 */
const AUDITION_STYLE = `<style data-cutroom-audition>[data-cutroom-version]:not([data-cutroom-shown]),[data-cutroom-version]:not([data-cutroom-shown]) *,video[data-cutroom-version]:not([data-cutroom-shown]) + canvas[data-cutroom-video-hold]{visibility:hidden!important;opacity:0!important;pointer-events:none!important}</style>`;
function installAudition(
  source: string,
  nextAudition: (available: number[], current: number) => number | undefined,
) {
  const win = window as Window & {
    __cutroomAuditionGains?: WeakMap<HTMLMediaElement, GainNode>;
    __cutroomAuditionResident?: (
      media: HTMLMediaElement,
      needed: boolean,
    ) => boolean;
    __cutroomRefreshAudition?: () => void;
    __cutroomShowAudition?: (
      video: HTMLVideoElement,
      show: () => boolean,
    ) => void;
  };
  win.__cutroomAuditionGains = new WeakMap();
  const sources = new Map<HTMLMediaElement, string>();
  let selected: number | undefined;
  let outgoing: number | undefined;
  const hostsOf = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-cutroom-version]"),
    );
  const refresh = () => {
    const hosts = hostsOf();
    for (const host of hosts) {
      if (!(host instanceof HTMLMediaElement) || sources.has(host)) continue;
      const src = host.dataset.cutroomVersionSrc ?? host.getAttribute("src");
      if (src) sources.set(host, src);
    }
    if (selected === undefined) {
      const shown = hosts.find((host) =>
        host.hasAttribute("data-cutroom-shown"),
      );
      if (shown) selected = Number(shown.dataset.cutroomVersion);
    }
    if (selected === undefined) return;
    const available = [
      ...new Set(hosts.map((host) => Number(host.dataset.cutroomVersion))),
    ].sort((a, b) => a - b);
    const next = nextAudition(available, selected);
    for (const [media, src] of sources) {
      const index = Number(media.dataset.cutroomVersion);
      const needed =
        index === selected ||
        index === next ||
        media.hasAttribute("data-cutroom-shown") ||
        (media instanceof HTMLAudioElement && index === outgoing);
      const resident = win.__cutroomAuditionResident?.(media, needed) ?? needed;
      if (resident && !media.hasAttribute("src")) {
        media.preload = "auto";
        media.setAttribute("src", src);
      } else if (!resident && media.hasAttribute("src")) {
        media.removeAttribute("src");
        media.load();
      }
    }
  };
  win.__cutroomRefreshAudition = refresh;
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", refresh, { once: true });
  else refresh();

  let request = 0;
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || data.source !== source || !Number.isInteger(data.version))
      return;
    const hosts = hostsOf();
    const index = String(data.version);
    if (!hosts.some((host) => host.dataset.cutroomVersion === index)) return;
    selected = data.version;
    refresh();
    const mine = ++request;
    const show = () => {
      if (request !== mine) return false;
      for (const host of hosts) {
        const shown = host.dataset.cutroomVersion === index;
        if (host instanceof HTMLMediaElement) {
          const node = win.__cutroomAuditionGains?.get(host);
          if (node) {
            const at = node.context.currentTime;
            node.gain.cancelAndHoldAtTime(at);
            node.gain.linearRampToValueAtTime(shown ? 1 : 0, at + 0.01);
          }
        } else {
          for (const media of host.querySelectorAll<HTMLMediaElement>(
            "video,audio",
          ))
            media.muted = !shown || media.hasAttribute("muted");
        }
      }
      const previous = hosts.find((host) =>
        host.hasAttribute("data-cutroom-shown"),
      );
      outgoing = previous ? Number(previous.dataset.cutroomVersion) : undefined;
      for (const host of hosts)
        host.toggleAttribute(
          "data-cutroom-shown",
          host.dataset.cutroomVersion === index,
        );
      refresh();
      setTimeout(() => {
        if (request !== mine) return;
        outgoing = undefined;
        refresh();
      }, 25);
      requestAnimationFrame(() =>
        parent.postMessage({ source, shown: data.version }, "*"),
      );
      return true;
    };
    const video = hosts.find(
      (host): host is HTMLVideoElement =>
        host instanceof HTMLVideoElement &&
        host.dataset.cutroomVersion === index,
    );
    if (video && win.__cutroomShowAudition)
      win.__cutroomShowAudition(video, show);
    else show();
  });
}
const AUDITION_SCRIPT = `<script data-cutroom-audition>(${installAudition.toString()})(${JSON.stringify(AUDITION_MESSAGE)}, ${nextAudition.toString()})</script>`;

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
  const facts = await compositionMediaFacts(
    project,
    composition,
    source.content,
  );
  const parsed = parseComposition(source.content, emptyTimelineSettings(), {
    scope: compositionScope(composition),
    mediaLengths: facts.lengths,
    silentMedia: facts.silent,
    mediaFiles: facts.files,
  });
  const clip = parsed.timeline.clips.find(({ id }) => id === clipId);
  const element = parsed.elements.get(clipId);
  if (!clip?.versions || !element) return html;
  if (mediaVersions(clip.kind))
    return mediaAudition(html, composition, parsed, clipId);
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

/** Alternate takes share the compiled clip's layout, timing, colour and audio routing. */
function mediaAudition(
  html: string,
  composition: string,
  parsed: ReturnType<typeof parseComposition>,
  clipId: string,
) {
  const { clips, fps } = parsed.timeline;
  const picture = clips.find(({ id }) => id === clipId);
  if (!picture?.versions) return html;
  const document = parse(html, { sourceCodeLocationInfo: true });
  const headEnd = findByName(document.childNodes, "head")?.sourceCodeLocation
    ?.endTag?.startOffset;
  if (headEnd === undefined) return html;
  const active = activeVersion(picture);
  const edits = [{ at: headEnd, html: AUDITION_STYLE + AUDITION_SCRIPT }];
  for (const clip of [picture, ...versionPartners(clips, picture)]) {
    const host = findById(document.childNodes, clip.id);
    const loc = host?.sourceCodeLocation;
    if (
      !host ||
      !loc?.startTag ||
      (host.tagName !== "video" && host.tagName !== "audio")
    )
      continue;
    const attrs = Object.fromEntries(
      host.attrs.map(({ name, value }) => [name, value]),
    );
    const group: AttributeChange[] = [
      ["data-cutroom-version-owner", clip.id],
      ["data-cutroom-version", String(active)],
      ["data-cutroom-shown", ""],
    ];
    edits.push({
      at: loc.startTag.endOffset - 1,
      html: attributeMarkup(group),
    });
    const keep = Object.entries(attrs).filter(
      ([name]) =>
        !OWN_ATTRIBUTES.has(name) &&
        ![
          "data-media-start",
          "data-playback-start",
          "data-hf-render-id",
          "data-hf-cutroom-clip-id",
          "preload",
        ].includes(name) &&
        !(
          clip.versionSilent &&
          attrs[VERSION_SILENT_ATTRIBUTE] !== "muted" &&
          name === "muted"
        ),
    );
    for (const [index, version] of picture.versions.entries()) {
      if (index === active || version.offline || version.fits === false)
        continue;
      if (host.tagName === "audio" && clip !== picture && version.silent)
        continue;
      const path = localMediaPath(composition, version.src);
      if (
        !path ||
        path.startsWith("../") ||
        path.split("/").some((part) => part.startsWith("."))
      )
        continue;
      const url = path.split("/").map(encodeURIComponent).join("/");
      // The element starts at the transition handle, on the clip's own source map.
      const start =
        sourceAtEdge(
          {
            ...clip,
            mediaStart:
              versionStart(version, fps) +
              (clip.mediaStart ?? 0) -
              (picture.mediaStart ?? 0),
          },
          frames(clip.start, fps),
          frames(elementBounds(clip).start, fps),
          fps,
        ).mediaStart ?? 0;
      const alternate: AttributeChange[] = [
        ["id", `cutroom-version-${clip.id}-${index}`],
        ["data-cutroom-version-owner", clip.id],
        ["data-cutroom-version", String(index)],
        ["data-cutroom-version-src", url],
        ["preload", "none"],
        ["data-media-start", String(Math.max(0, start))],
        ...keep,
      ];
      edits.push({
        at: loc.endOffset,
        html: `<${host.tagName}${attributeMarkup(alternate)}></${host.tagName}>`,
      });
    }
  }
  return edits
    .toSorted((a, b) => b.at - a.at)
    .reduce(
      (page, { at, html }) => page.slice(0, at) + html + page.slice(at),
      html,
    );
}
