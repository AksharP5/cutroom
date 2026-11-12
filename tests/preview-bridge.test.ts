import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { browserExecutable } from "../src/server/hyperframes/render";
import { AnimationWindowsSchema } from "../src/shared/preview";
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

test.skipIf(!browserExecutable())(
  "bridge reports built literal, loop and helper tween starts per request, excluding registered children",
  async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      executablePath: browserExecutable(),
      headless: true,
      args: ["--no-sandbox", "--mute-audio"],
    });
    try {
      const page = await browser.newPage();
      const gsap = await readFile("node_modules/gsap/dist/gsap.min.js", "utf8");
      await page.setContent(
        withPreviewBridge(`<!doctype html><html><body>
      <main data-composition-id="main" data-duration="48">
        <div id="literal" data-start="36" data-duration="4"></div>
        <div id="loop" data-start="6" data-duration="4"><span></span><span></span></div>
        <div id="helper" data-start="12" data-duration="4"></div>
        <div id="constructor" data-start="18" data-duration="4"></div>
        <div id="nested" data-composition-id="nested" data-start="24" data-duration="4"><span></span></div>
      </main><script>${gsap}</script><script>
        window.reports = [];
        window.replies = [];
        addEventListener('message', event => { if (event.data.type === 'animation-windows') reports.push(event.data); if (event.data.id) replies.push(event.data.id); });
        window.__player = {getTime: () => 0, isPlaying: () => false};
        window.__renderReady = false;
        window.__hfTimelinesBuilding = true;
        document.fonts.ready.then(() => setTimeout(() => {
          const tl = gsap.timeline({paused:true});
          tl.to('#literal', {opacity: 0, duration: .5}, 36);
          document.querySelectorAll('#loop span').forEach((word, i) => tl.from(word, {opacity:0, duration:.4}, 6 + i * .15));
          function fade(target, time) {tl.fromTo(target, {opacity:0}, {opacity:1, duration:.5}, time);}
          fade('#helper', 12);
          fade('#constructor', 18);
          const manual = gsap.timeline().to('#helper', {x:10, duration:.25}, .5);
          manual.timeScale(2);
          tl.add(manual, 13);
          tl.set('#literal', {x:20}, 40);
          const child = gsap.timeline().to('#nested span', {opacity:0, duration:.5}, 0);
          tl.add(child, 24);
          window.__timelines = {main:tl, nested:child};
          window.__hfTimelinesBuilding = false;
          window.__renderReady = true;
        }, 80));
      </script></body></html>`),
      );
      await page.evaluate(() =>
        window.postMessage(
          {
            source: "cutroom-viewer",
            id: "first",
            action: "animation-windows",
          },
          "*",
        ),
      );
      await page.waitForFunction("window.reports.length === 1", {
        timeout: 2000,
      });
      const report = AnimationWindowsSchema.parse(
        await page.evaluate("window.reports[0]"),
      );
      expect(
        Object.fromEntries(
          Object.entries(report.windows).map(([id, pairs]) => [
            id,
            pairs.flatMap(([, starts]) => starts),
          ]),
        ),
      ).toEqual({
        literal: [36, 40],
        loop: [6, 6.15],
        helper: [12, 13.25],
        constructor: [18],
      });
      for (const pairs of Object.values(report.windows))
        expect(new Set(pairs.map(([id]) => id)).size).toBe(pairs.length);
      await page.evaluate(() =>
        window.postMessage(
          {
            source: "cutroom-viewer",
            id: "second",
            action: "animation-windows",
          },
          "*",
        ),
      );
      await page.waitForFunction("window.replies.includes('second')");
      expect(await page.evaluate("window.reports.length")).toBe(2);
    } finally {
      await browser.close();
    }
  },
);

test.skipIf(!browserExecutable())(
  "internal stagger and keyframe starts include duration, easing and parent time scales; getters and seeks do not report",
  async () => {
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      executablePath: browserExecutable(),
      headless: true,
      args: ["--no-sandbox", "--mute-audio"],
    });
    try {
      const page = await browser.newPage();
      const gsap = await readFile("node_modules/gsap/dist/gsap.min.js", "utf8");
      await page.setContent(
        withPreviewBridge(`<!doctype html><html><body><main data-composition-id="main" data-duration="40"><div id="title" class="shared" data-start="8" data-duration="4"></div><div id="still" class="shared" data-start="6" data-duration="4"></div><div id="framed" data-start="10" data-duration="8"></div><div id="nested" data-composition-id="nested" data-start="15" data-duration="4"></div></main><script>${gsap}</script><script>
        window.reports=[];addEventListener('message',e=>{if(e.data.type==='animation-windows')reports.push(e.data)});
        window.__player={getTime:()=>0,isPlaying:()=>false};window.__renderReady=true;
        const tl=gsap.timeline({paused:true});
        tl.to('.shared',{x:100,duration:1,stagger:(i,target)=>+target.dataset.start-6},6);
        const timedParent=gsap.timeline();
        timedParent.to('#framed',{duration:8,ease:'power2.in',keyframes:[{x:20,duration:1},{y:20,duration:1}]},2);
        timedParent.timeScale(2);tl.add(timedParent,10);
        const registered=gsap.timeline().to('#nested',{x:20,duration:1},0);tl.add(registered,15);
        window.__timelines={main:tl,nested:registered};
      </script></body></html>`),
      );
      await page.evaluate(() =>
        window.postMessage(
          { source: "cutroom-viewer", id: "read", action: "animation-windows" },
          "*",
        ),
      );
      await page.waitForFunction("window.reports.length>0");
      const report = AnimationWindowsSchema.parse(
        await page.evaluate("window.reports.at(-1)"),
      );
      expect(report.windows.title?.flatMap(([, starts]) => starts)).toEqual([
        8,
      ]);
      expect(report.windows.still?.flatMap(([, starts]) => starts)).toEqual([
        6,
      ]);
      const framed = report.windows.framed!.flatMap(([, starts]) => starts);
      expect(framed[0]).toBe(11);
      expect(framed[1]).toBeCloseTo(14.1748021, 6);
      expect(report.windows.nested).toBeUndefined();
      const count = await page.evaluate("window.reports.length");
      await page.evaluate(
        `void function(){for(let i=0;i<10;i++){const tl=window.__timelines.main;tl.startTime();tl.duration();tl.totalDuration();tl.delay();tl.timeScale();tl.seek(i/10);}}()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await page.evaluate("window.reports.length")).toBe(count);
      await page.evaluate(
        "void window.__timelines.main.getChildren(false,true,false)[0].startTime(8)",
      );
      await page.waitForFunction(`window.reports.length>${count}`);
      const changed = AnimationWindowsSchema.parse(
        await page.evaluate("window.reports.at(-1)"),
      );
      expect(changed.windows.title?.flatMap(([, starts]) => starts)).toEqual([
        10,
      ]);
    } finally {
      await browser.close();
    }
  },
);
