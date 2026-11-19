import { join } from "node:path";
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { transform } from "lightningcss";
import type { Selector } from "lightningcss";
import { exportClipWindow, parseFpsWithDefault } from "@hyperframes/core";
import { hostInPointSeconds } from "@hyperframes/core/media-timing";
import {
  AudioAutomationError,
  parseAutomation,
  RATE_TARGET,
  serializeAutomation,
} from "@hyperframes/core/audio-automation";
import type { HfAutomation } from "@hyperframes/core/audio-automation";
import { readMediaOffsetSeconds } from "@hyperframes/parsers/media-duration";
import { requestSubPath } from "@hyperframes/studio-server";
import { isPrivateProjectFile } from "@hyperframes/studio-server/safe-path";
import { HttpError } from "../../shared/errors";
import { mediaKind } from "../../shared/media";
import type { Project } from "../../shared/project";
import { projectPath } from "../projects/store";
import type { RampWindow } from "../media/protocol";
import type { MediaService } from "../media/service";

type Edit = { from: number; to: number; text: string };
type RampAsset = { path: string; window: RampWindow };
const companionAttrs = [
  "data-start",
  "data-duration",
  "data-end",
  "data-track-index",
  "data-hf-auto-start",
  "data-hf-media-start-basis",
  "data-hf-authored-duration",
  "data-hf-authored-end",
  "data-volume",
  "data-audio-group",
  "data-hf-group-render-id",
  "data-fade-in",
  "data-fade-out",
  "data-fx-chain",
  "data-muted",
];
const attr = (name: string, value: string) =>
  ` ${name}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"`;

const replacedAttrs = new Set([
  "src",
  "data-automation",
  "data-media-start",
  "data-playback-start",
  "data-playback-rate",
]);

/** A derived sound element must not change which authored styles match the picture. */
function safeStyles(styles: string[], external: boolean) {
  let audio = !external;
  let video = !external;
  const inspect = (selector: Selector) => {
    for (const part of selector) {
      if (
        part.type === "attribute" &&
        replacedAttrs.has(part.name.toLowerCase())
      )
        audio = video = false;
      if (
        (part.type === "attribute" && part.name.toLowerCase() === "muted") ||
        (part.type === "type" && part.name.toLowerCase() === "audio") ||
        (part.type === "combinator" &&
          ["next-sibling", "later-sibling"].includes(part.value)) ||
        (part.type === "id" && part.name.startsWith("cutroom-ramp-"))
      )
        video = false;
      if (part.type !== "pseudo-class") continue;
      if (
        part.kind === "is" ||
        part.kind === "not" ||
        part.kind === "where" ||
        part.kind === "any"
      ) {
        part.selectors.forEach(inspect);
        continue;
      }
      if (part.kind === "has") {
        part.selectors.forEach(inspect);
        // HyperFrames scopes a scene by checking for this compiler-owned root.
        if (
          !part.selectors.every(
            (parts) =>
              parts.length === 1 &&
              parts[0]?.type === "attribute" &&
              parts[0].name === "data-hf-inner-root" &&
              !parts[0].operation,
          )
        )
          video = false;
        continue;
      }
      if (
        ![
          "root",
          "hover",
          "focus",
          "focus-visible",
          "focus-within",
          "active",
        ].includes(part.kind)
      )
        audio = video = false;
    }
  };
  for (const style of styles) {
    if (!(audio || video)) break;
    try {
      transform({
        filename: "preview.css",
        code: Buffer.from(style),
        visitor: {
          Rule(rule) {
            if (rule.type === "import") audio = video = false;
          },
          Selector: inspect,
        },
      });
    } catch {
      return { audio: false, video: false };
    }
  }
  return { audio, video };
}

/** Project files and compiled Studio cache retain the authored source. */
export async function prepareRampPreview(
  html: string,
  request: URL,
  prefix: string,
  project: Project,
  media: MediaService,
) {
  if (!html.includes("data-automation") || !html.includes("rate")) return null;
  const document = parse(html, { sourceCodeLocationInfo: true });
  type Node = DefaultTreeAdapterTypes.Element;
  const entries: { node: Node; fps: number }[] = [];
  const ids = new Set<string>();
  const styles: string[] = [];
  let externalStyle = false;
  let base: string | undefined;
  const visit = (
    parent: DefaultTreeAdapterTypes.ParentNode,
    fps: number,
    hidden: boolean,
  ) => {
    for (const node of parent.childNodes) {
      if (!("tagName" in node)) continue;
      const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
      const id = attrs.get("id");
      if (id) ids.add(id);
      if (node.tagName === "base") base ??= attrs.get("href");
      if (
        node.tagName === "link" &&
        /(?:^|\s)stylesheet(?:\s|$)/i.test(attrs.get("rel") ?? "")
      )
        externalStyle = true;
      if (node.tagName === "style")
        styles.push(
          node.childNodes
            .map((child) => ("value" in child ? child.value : ""))
            .join(""),
        );
      const parsed = parseFpsWithDefault(attrs.get("data-fps") ?? String(fps));
      const nodeFps = parsed.ok ? parsed.value.num / parsed.value.den : fps;
      // The producer rebases a rate lane at a trimmed mount's in-point.
      // Keep the native path until both render paths share that phase.
      const trimmedMount =
        [
          "data-composition-id",
          "data-composition-src",
          "data-composition-file",
        ].some((name) => attrs.has(name)) &&
        hostInPointSeconds({
          getAttribute: (name) => attrs.get(name) ?? null,
        }) > 0;
      const disabled = hidden || attrs.has("data-hidden") || trimmedMount;
      if (!disabled && (node.tagName === "audio" || node.tagName === "video"))
        entries.push({ node, fps: nodeFps });
      visit(node, nodeFps, disabled);
    }
  };
  visit(document, 30, false);
  const safe = safeStyles(styles, externalStyle);
  const documentBase = URL.parse(base ?? request.href, request);
  if (!documentBase) return null;
  const edits: Edit[] = [];
  const pending: Promise<boolean>[] = [];
  const assets = new Map<string, RampAsset>();
  let ramp = false;
  await Promise.all(
    entries.map(async ({ node, fps }, index) => {
      if (node.tagName === "audio" ? !safe.audio : !safe.video) return;
      const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
      const raw = attrs.get("data-automation");
      const location = node.sourceCodeLocation;
      const src = attrs.get("src");
      if (
        !raw ||
        !src ||
        !location?.startTag ||
        attrs.has("loop") ||
        attrs.has("muted") ||
        attrs.has("data-var-src") ||
        (node.tagName === "video" &&
          (!location.endTag ||
            ![undefined, "true"].includes(attrs.get("data-has-audio"))))
      )
        return;
      let envelope: HfAutomation;
      try {
        envelope = parseAutomation(raw);
      } catch (error) {
        if (!(error instanceof AudioAutomationError)) throw error;
        // A source diagnostic shouldn't make the whole viewer unavailable.
        return;
      }
      const lane = envelope.lanes.find((entry) => entry.target === RATE_TARGET);
      if (!lane?.points.length) return;
      // Nested mounts retain their clip-local timing, including the original ease
      // phase. A numeric local window keeps the dry audio independent of its hosts.
      const start = Number(attrs.get("data-start"));
      const end = attrs.has("data-duration")
        ? start + Number(attrs.get("data-duration"))
        : Number(attrs.get("data-end"));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        return;
      const clip = exportClipWindow(start, end, fps);
      if (clip.end <= clip.start) return;
      const url = URL.parse(src, documentBase);
      if (
        !url ||
        url.origin !== request.origin ||
        !url.pathname.startsWith(`${prefix}preview/`) ||
        url.search ||
        url.hash
      )
        return;
      const path = requestSubPath(url.href, "isolated/:key/preview");
      if (path.includes("\0") || !mediaKind(path)) return;
      const canonical = await projectPath(project, path).catch(
        (error: unknown) => {
          if (error instanceof HttpError && error.status < 500) return null;
          if (
            error instanceof Error &&
            "code" in error &&
            ["ENOTDIR", "EACCES", "EPERM"].includes(String(error.code))
          )
            return null;
          throw error;
        },
      );
      if (
        !canonical ||
        isPrivateProjectFile(project.path, join(project.path, path))
      )
        return;
      ramp = true;
      const window = {
        start: readMediaOffsetSeconds((name) => attrs.get(name) ?? null),
        duration: clip.end - clip.start,
        rate: serializeAutomation({ ...envelope, lanes: [lane] }),
      };
      const result = await media
        .rampAudio(project, path, window)
        .catch((error: unknown) => {
          console.warn("Could not prepare preview ramp audio:", error);
          return null;
        });
      if (!result) return;
      if (result.pending) pending.push(result.pending);
      if (!result.available) return;
      assets.set(result.key, { path, window });
      const prepared = `${prefix}ramp-audio/${result.key}.wav`;
      const remaining = envelope.lanes.filter(
        (entry) => entry.target !== RATE_TARGET,
      );
      const audio = remaining.length
        ? serializeAutomation({ ...envelope, lanes: remaining })
        : null;
      if (node.tagName === "video") {
        let id = `cutroom-ramp-${index}`;
        while (ids.has(id)) id += "-";
        ids.add(id);
        const routing = companionAttrs
          .flatMap((name) => {
            const value = attrs.get(name);
            return value === undefined ? [] : [attr(name, value)];
          })
          .join("");
        edits.push({
          from: location.endTag!.endOffset,
          to: location.endTag!.endOffset,
          text: `<audio style="display:none!important"${attr("id", id)}${attr("src", prepared)}${routing}${audio ? attr("data-automation", audio) : ""}></audio>`,
        });
        const offset = location.startTag.endOffset - 1;
        edits.push({ from: offset, to: offset, text: " muted" });
        return;
      }
      const replacements = new Map([
        ["src", prepared],
        ["data-automation", audio],
        ["data-media-start", null],
        ["data-playback-start", null],
        ["data-playback-rate", null],
      ]);
      for (const [name, value] of replacements) {
        const span = location.attrs?.[name];
        if (span)
          edits.push({
            from: span.startOffset,
            to: span.endOffset,
            text: value === null ? "" : attr(name, value).slice(1),
          });
      }
    }),
  );
  if (!ramp) return null;
  for (const { from, to, text } of edits.sort((a, b) => b.from - a.from))
    html = html.slice(0, from) + text + html.slice(to);
  return { html, assets, pending };
}
