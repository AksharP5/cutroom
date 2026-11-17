import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { previewTimingPolicy } from "../src/server/hyperframes/previewTimingPolicy";

for (const [name, extra, allowed] of [
  ["plain", "", true],
  [
    "a timeline at literal times, by selector",
    '<script src="gsap.min.js"></script><script>window.__timelines={main:gsap.timeline({paused:true}).from("#title",{x:-40,duration:1},1)}</script>',
    true,
  ],
  [
    "assigned markup",
    "<script>document.querySelector('#title').innerHTML='<span>Title</span>'</script>",
    true,
  ],
  [
    "init-time timing reads",
    "<script>window.at=+document.querySelector('#title').dataset.start</script>",
    false,
  ],
  [
    "timing read by attribute",
    "<script>window.at=document.querySelector('#title').getAttribute('data-start')</script>",
    false,
  ],
  [
    "read markup",
    "<script>window.page=document.body.innerHTML</script>",
    false,
  ],
  [
    "read document text",
    "<script>window.count=(document.body.textContent.match(/^Card$/gm)||[]).length</script>",
    false,
  ],
  [
    "neighbouring elements",
    "<script>window.next=document.querySelector('#title').nextElementSibling</script>",
    false,
  ],
  ["unscanned code", "<script>Function('return 1')()</script>", false],
  [
    "bridge messages",
    "<script>parent.postMessage({source:'cutroom-preview'},'*')</script>",
    false,
  ],
  [
    "runtime state",
    "<script>window.length=__player.getDuration()</script>",
    false,
  ],
  [
    "spoofed runtime marker",
    '<script data-hyperframes-preview-runtime="1">window.authored=true</script>',
    false,
  ],
  [
    "handlers",
    '<img src="missing.png" onerror="parent.postMessage({})">',
    false,
  ],
  [
    "navigation",
    '<meta http-equiv="refresh" content="0;url=other.html">',
    false,
  ],
  // The compiler hoists scripts out of fallback tags that a browser treats as inert text.
  ...["noscript", "noembed", "noframes", "plaintext"].map(
    (tag) =>
      [
        tag,
        `<${tag}><script>window.at=document.querySelector('#title').dataset.start</script></${tag}>`,
        false,
      ] as const,
  ),
  ["pinned GSAP", '<script src="gsap.min.js"></script>', true],
  // App state is outside the preview signature, so a later change there would go unseen.
  [
    "pinned GSAP in app state",
    '<script src=".cutroom/gsap.min.js"></script>',
    false,
  ],
  ["changed library", '<script src="changed.js"></script>', false],
] as const)
  test(`known script dependencies decide live timing eligibility: ${name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "timing-policy-"));
    try {
      await mkdir(join(dir, ".cutroom"));
      for (const copy of ["gsap.min.js", ".cutroom/gsap.min.js"])
        await copyFile(
          fileURLToPath(import.meta.resolve("gsap/dist/gsap.min.js")),
          join(dir, copy),
        );
      await writeFile(join(dir, "changed.js"), "parent.postMessage({})");
      await writeFile(
        join(dir, "index.html"),
        `<html><head><meta name="cutroom-timing-contract" content="attributes"></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="5"><div class="clip" id="title" data-start="0" data-duration="4">Title</div></main>${extra}</body></html>`,
      );
      const policy = previewTimingPolicy(dir);
      await bundleToSingleHtml(dir, {
        runtime: "placeholder",
        inlineAssets: false,
        onRead: policy.read,
      });
      expect(policy.contract()).toBe(allowed ? "attributes" : null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

for (const [script, allowed] of [
  [
    "{const tl=gsap.timeline({paused:true});tl.from('.clip',{opacity:0,duration:1},0);window.__timelines.scene=tl}",
    true,
  ],
  ["window.end=document.querySelector('.clip').dataset.duration", false],
] as const)
  test(`a mounted sub-composition script decides live timing on its root: ${allowed ? "literal" : "reads timing"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "timing-scene-"));
    try {
      await writeFile(
        join(dir, "index.html"),
        '<html><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="4"><div data-composition-src="scene.html" data-start="0" data-duration="4"></div></main></body></html>',
      );
      await writeFile(
        join(dir, "scene.html"),
        `<template><main data-composition-id="scene" data-width="640" data-height="360" data-duration="4"><div class="clip" data-start="0" data-duration="4">Title</div></main><script>${script}</script></template>`,
      );
      const policy = previewTimingPolicy(dir);
      await bundleToSingleHtml(dir, {
        runtime: "placeholder",
        inlineAssets: false,
        onRead: policy.read,
      });
      expect(policy.contract()).toBe(allowed ? "attributes" : null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

for (const [scene, allowed] of [
  ["scene.html", true],
  [".cutroom/scene.html", false],
] as const)
  test(`a script-free sub-composition qualifies only outside app state: ${scene}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "timing-scene-"));
    try {
      await mkdir(join(dir, ".cutroom"));
      await writeFile(
        join(dir, "index.html"),
        `<html><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="4"><div data-composition-src="${scene}" data-start="0" data-duration="4"></div></main></body></html>`,
      );
      await writeFile(
        join(dir, scene),
        '<template><main data-composition-id="scene" data-width="640" data-height="360" data-duration="4"><div class="clip" data-start="0" data-duration="4">Title</div></main></template>',
      );
      const reads: string[] = [];
      const policy = previewTimingPolicy(dir);
      await bundleToSingleHtml(dir, {
        runtime: "placeholder",
        inlineAssets: false,
        onRead: (path) => {
          reads.push(path);
          policy.read(path);
        },
      });
      expect(reads).toContain(join(dir, scene));
      expect(policy.contract()).toBe(allowed ? "attributes" : null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
