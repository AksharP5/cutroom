import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import {
  previewTimingPolicy,
  readTimingContract,
  stampTimingContract,
} from "../src/server/hyperframes/previewTimingPolicy";
import { parse } from "parse5";

for (const [name, extra, allowed] of [
  ["plain", "", true],
  [
    "init-time timing reads",
    "<script>window.at=+document.querySelector('#title').dataset.start</script>",
    false,
  ],
  [
    "spoofed runtime marker",
    '<script data-hyperframes-preview-runtime="1">parent.postMessage({})</script>',
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
  [
    "noscript",
    "<noscript><script>window.authored=true</script></noscript>",
    false,
  ],
  ...["noembed", "noframes", "plaintext"].map(
    (tag) =>
      [
        tag,
        `<${tag}><script>window.authored=true</script></${tag}>`,
        false,
      ] as const,
  ),
  ["pinned GSAP", '<script src="gsap.min.js"></script>', true],
  ["changed library", '<script src="changed.js"></script>', false],
] as const)
  test(`only script-free sources qualify: ${name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "timing-policy-"));
    try {
      await copyFile(
        fileURLToPath(import.meta.resolve("gsap/dist/gsap.min.js")),
        join(dir, "gsap.min.js"),
      );
      await writeFile(join(dir, "changed.js"), "parent.postMessage({})");
      await writeFile(
        join(dir, "index.html"),
        `<html><head><meta name="cutroom-timing-contract" content="attributes"></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="5"><div class="clip" id="title" data-start="0" data-duration="4">Title</div></main>${extra}</body></html>`,
      );
      const policy = previewTimingPolicy(dir);
      const html = await bundleToSingleHtml(dir, {
        runtime: "placeholder",
        inlineAssets: false,
        onRead: policy.read,
      });
      expect(policy.contract()).toBe(allowed ? "attributes" : null);
      expect(
        readTimingContract(parse(stampTimingContract(html, policy.contract()))),
      ).toBe(allowed ? "attributes" : null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

test("a mounted sub-composition script prevents live timing on its root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "timing-scene-"));
  try {
    await writeFile(
      join(dir, "index.html"),
      '<html><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="4"><div data-composition-src="scene.html" data-start="0" data-duration="4"></div></main></body></html>',
    );
    await writeFile(
      join(dir, "scene.html"),
      '<template><main data-composition-id="scene" data-width="640" data-height="360" data-duration="4"><div class="clip" data-start="0" data-duration="4">Title</div></main><script>window.authored=true</script></template>',
    );
    const policy = previewTimingPolicy(dir);
    await bundleToSingleHtml(dir, {
      runtime: "placeholder",
      inlineAssets: false,
      onRead: policy.read,
    });
    expect(policy.contract()).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
