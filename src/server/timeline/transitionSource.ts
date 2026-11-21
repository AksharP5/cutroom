import { parseFpsWithDefault } from "@hyperframes/core";
import { parseRateLane } from "@hyperframes/core/speed-ramp";
import { readPlaybackRate } from "@hyperframes/parsers";
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { offsetSourceTime } from "../../shared/timeline/time.ts";
import type { Fps } from "../../shared/timeline/schema.ts";

/** Restore the exact frame grid before FFmpeg samples a saved video transition handle. */
export function transitionSourceTimes(html: string): string {
  if (!html.includes("data-transition-in")) return html;
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (nodes: DefaultTreeAdapterTypes.ChildNode[], fps: Fps) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      const attr = (name: string) =>
        node.attrs.find((attribute) => attribute.name === name)?.value;
      const declared = attr("data-fps");
      const parsed =
        declared === undefined ? null : parseFpsWithDefault(declared);
      const rate = parsed?.ok ? parsed.value : fps;
      if (node.tagName === "video" && attr("data-transition-in")) {
        const attrs = Object.fromEntries(
          node.attrs.map(({ name, value }) => [name, value]),
        );
        const alignment = attrs["data-transition-in-align"];
        const name =
          attrs["data-playback-start"] !== undefined
            ? "data-playback-start"
            : "data-media-start";
        const source = attrs[name];
        const location = node.sourceCodeLocation?.attrs?.[name];
        if (
          (alignment === "center" || alignment === "end") &&
          !parseRateLane(attrs["data-automation"]) &&
          location &&
          source?.trim()
        ) {
          const seconds = Number(source);
          const exact = offsetSourceTime(
            seconds,
            0,
            rate,
            readPlaybackRate((key) => attrs[key] ?? null),
          );
          if (Number.isFinite(exact) && exact >= 0 && exact !== seconds)
            edits.push({
              start: location.startOffset,
              end: location.endOffset,
              text: `${name}="${exact}"`,
            });
        }
      }
      visit(node.childNodes, rate);
      if ("content" in node) visit(node.content.childNodes, rate);
    }
  };
  visit(parse(html, { sourceCodeLocationInfo: true }).childNodes, {
    num: 30,
    den: 1,
  });
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce(
      (source, { start, end, text }) =>
        source.slice(0, start) + text + source.slice(end),
      html,
    );
}
