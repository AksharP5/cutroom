import { expect, test } from "bun:test";
import { parse } from "parse5";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";
import type { DefaultTreeAdapterTypes } from "parse5";
import { parseComposition } from "../src/server/timeline/composition";
import { emptyTimelineSettings } from "../src/shared/timeline/schema";
import {
  withPreviewBridge,
  withPreviewClipIdentities,
} from "../src/server/hyperframes/previewBridge";

function videoAttributes(source: string) {
  const visit = (
    nodes: DefaultTreeAdapterTypes.ChildNode[],
  ): Map<string, string>[] =>
    nodes.flatMap((node) => {
      if (!("tagName" in node)) return [];
      if (node.tagName === "video")
        return [new Map(node.attrs.map(({ name, value }) => [name, value]))];
      return visit(node.childNodes);
    });
  return visit(parse(withPreviewBridge(source)).childNodes);
}

test("served split boundaries use exact frames, keeping source offsets and authored fractional timing", () => {
  const [split, fractional] =
    videoAttributes(`<main data-composition-id="main" data-fps="30">
    <video data-start="3.366667" data-duration="0.033333" data-media-start="1.234567" src="picture.mp4"></video>
    <video data-start="3.3711" data-duration="0.024" src="picture.mp4"></video>
    </main>`);
  expect(Number(split!.get("data-start"))).toBe(101 / 30);
  expect(
    Number(split!.get("data-start")) + Number(split!.get("data-duration")),
  ).toBe(102 / 30);
  expect(split!.get("data-media-start")).toBe("1.234567");
  expect(split!.get("crossorigin")).toBe("anonymous");
  expect(fractional!.get("data-start")).toBe("3.3711");
  expect(fractional!.get("data-duration")).toBe("0.024");
});

test("preview boundaries follow the composition's rational frame rate and explicit ends", () => {
  const [video] =
    videoAttributes(`<main data-composition-id="main" data-fps="30000/1001">
    <div><video data-start="2.535867" data-end="2.569233" src="picture.mp4"></video></div>
    </main>`);
  expect(Number(video!.get("data-start"))).toBe((76 * 1001) / 30000);
  expect(Number(video!.get("data-end"))).toBe((77 * 1001) / 30000);
});

test("preview clip markers match the timeline for named, anonymous and colliding identities", () => {
  const html = `<main data-composition-id="main" data-duration="4">
    <div data-hf-id="front" data-start="0" data-duration="4">Front</div>
    <div data-start="0" data-duration="0">Never shown</div>
    <div data-start="0" data-duration="4">Generated</div>
    <div id="clip-1" data-start="0" data-duration="4">Reserved</div>
    <div data-hf-id="front" data-start="0" data-duration="4"><span data-start="0" data-duration="4">Nested</span></div>
  </main>`;
  const timeline = parseComposition(html, emptyTimelineSettings()).timeline;
  const markers: string[] = [];
  const visit = (nodes: DefaultTreeAdapterTypes.ChildNode[]) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      const marker = node.attrs.find(
        ({ name }) => name === "data-hf-cutroom-clip-id",
      );
      if (marker) markers.push(marker.value);
      visit(node.childNodes);
    }
  };
  visit(parse(withPreviewBridge(html)).childNodes);
  expect(markers).toEqual(["front", "clip-2", "clip-1", "clip-3"]);
  expect(markers.toSorted()).toEqual(
    timeline.clips.map((clip) => clip.id).toSorted(),
  );
  const compiled = withPreviewClipIdentities(ensureHfIds(html), html);
  markers.length = 0;
  visit(parse(withPreviewBridge(compiled)).childNodes);
  expect(markers).toEqual(["front", "clip-2", "clip-1", "clip-3"]);
});

test("standalone template previews keep the scoped timeline's generated identities", () => {
  const source = `<template><main data-composition-id="scene" data-duration="4"><div data-start="0" data-duration="4">Words</div></main></template>`;
  const compiled = ensureHfIds(
    `<html><body><main data-composition-id="scene" data-duration="4"><div data-start="0" data-duration="4">Words</div></main></body></html>`,
  );
  const marked = withPreviewClipIdentities(compiled, source, "sub-composition");
  expect(marked).toContain('data-hf-cutroom-clip-id="clip-1"');
  expect(
    parseComposition(source, emptyTimelineSettings(), {
      scope: "sub-composition",
    }).timeline.clips[0]!.id,
  ).toBe("clip-1");
});

test("measured media windows filter the same clips before assigning generated names", () => {
  const source = `<html><body><main data-composition-id="main" data-duration="4"><audio data-start="0.01" src="click.wav"></audio><div data-start="0" data-duration="4">Words</div></main></body></html>`;
  const lengths = new Map([["click.wav", 0.001]]);
  const marked = withPreviewClipIdentities(
    ensureHfIds(source),
    source,
    "document",
    lengths,
  );
  expect(
    parseComposition(source, emptyTimelineSettings(), {
      mediaLengths: lengths,
    }).timeline.clips.map((clip) => clip.id),
  ).toEqual(["clip-1"]);
  expect(marked).toContain('data-hf-cutroom-clip-id="clip-1"');
  expect(marked).not.toContain('data-hf-cutroom-clip-id="clip-2"');
  expect(marked.match(/data-hf-cutroom-clip-id=/g)).toHaveLength(1);
});
