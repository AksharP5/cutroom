import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LIBRARY_CATEGORIES } from "../src/shared/library";
import { LIBRARY_REF } from "../src/server/library/registry";

const POSTERS = "https://static.heygen.ai/hyperframes-oss/docs/images/catalog/";
/**
 * The library the Library specs use, saved where the server keeps its cache. A complete list and items
 * with cached files never reach the network, so the spec runs offline and the same every time.
 */
const libraryDir = join(
  resolve(process.env.CUTROOM_E2E_DIR ?? ".cutroom-dev/e2e", "data"),
  "library",
  LIBRARY_REF,
);
const bar = `<!doctype html>
<html><head><meta charset="UTF-8" /><script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script></head>
<body><div id="root" data-composition-id="lt-fixture" data-start="0" data-duration="2" data-width="640" data-height="360">
<style>[data-composition-id="lt-fixture"] { position: relative; width: 640px; height: 360px; overflow: hidden; }
.lt-card { position: absolute; left: 40px; top: 240px; width: 300px; height: 60px; background: #ffffff; }</style>
<div class="lt-card"></div>
<script>window.__timelines = window.__timelines || {}; const tl = gsap.timeline({ paused: true }); tl.from(".lt-card", { opacity: 0, duration: 0.2 }, 0); window.__timelines["lt-fixture"] = tl;</script>
</div></body></html>
`;
const fragment = `<div class="fx-word">Library</div>
<style>.fx-word { color: #ff3040; font: 700 64px/1 sans-serif; }</style>
<!--
  Timeline integration:
  tl.fromTo('.fx-word', { opacity: 0 }, { opacity: 1, duration: 0.2 }, startTime);
-->
`;
/** A transition: a full-frame wipe, 1 second, for dropping on a cut. */
const wipe = `<!doctype html>
<html><head><meta charset="UTF-8" /></head>
<body><div id="root" data-composition-id="tr-fixture" data-start="0" data-duration="1" data-width="640" data-height="360">
<style>[data-composition-id="tr-fixture"] { position: relative; width: 640px; height: 360px; } .wipe { position: absolute; inset: 0; background: #20c0ff; }</style>
<div class="wipe"></div>
<script>window.__timelines = window.__timelines || {}; window.__timelines["tr-fixture"] = { pause() {}, seek() {}, time: () => 0, duration: () => 1 };</script>
</div></body></html>
`;
const fixtures = [
  {
    name: "lt-fixture",
    type: "hyperframes:block",
    title: "Lower Third — Fixture",
    description: "A white card in the lower left",
    tags: ["lower-third"],
    license: "MIT",
    dimensions: { width: 640, height: 360 },
    duration: 2,
    variables: [],
    online: false,
    preview: { poster: `${POSTERS}lt-fixture.png` },
    files: [
      {
        path: "lt-fixture.html",
        target: "compositions/lt-fixture.html",
        type: "hyperframes:composition",
      },
    ],
  },
  {
    name: "tr-fixture",
    type: "hyperframes:block",
    title: "Fixture Wipe",
    description: "A full-frame wipe",
    tags: ["transition"],
    dimensions: { width: 640, height: 360 },
    duration: 1,
    variables: [],
    online: false,
    files: [
      {
        path: "tr-fixture.html",
        target: "compositions/tr-fixture.html",
        type: "hyperframes:composition",
      },
    ],
  },
  {
    name: "fx-fixture",
    type: "hyperframes:component",
    title: "Fixture Word",
    description: "A red word that fades in",
    tags: ["text-effect"],
    variables: [],
    online: false,
    files: [
      {
        path: "fx-fixture.html",
        target: "compositions/components/fx-fixture.html",
        type: "hyperframes:snippet",
      },
    ],
  },
];
/** A 1x1 white PNG, so poster requests are answered from the cache, never the network. */
const poster = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAvIL2ZQAAAABJRU5ErkJggg==",
  "base64",
);
/**
 * Synthetic blocks fill the list to the registry's real size (448 items), each with a poster, so
 * the panel opens and scrolls at the size owners see. None of them match the fixtures' words.
 */
export const LIBRARY_SIZE = 448;
const synthetic = Array.from({ length: LIBRARY_SIZE - 3 }, (_, index) => {
  const name = `synthetic-${index + 1}`;
  const category = LIBRARY_CATEGORIES[index % LIBRARY_CATEGORIES.length]!;
  return {
    name,
    type: "hyperframes:block",
    title: `Synthetic ${index + 1}`,
    description: "A generated scene",
    tags: [category.id === "lower-thirds" ? "scene" : category.id],
    dimensions: { width: 640, height: 360 },
    duration: 1 + (index % 5),
    variables: [],
    online: false,
    files: [
      {
        path: "s.html",
        target: `compositions/${name}.html`,
        type: "hyperframes:composition",
      },
    ],
    preview: { poster: `${POSTERS}${name}.png` },
  };
});
const items = [...fixtures, ...synthetic];
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export async function seedLibrary() {
  const write = async (path: string, content: string | Uint8Array) => {
    await mkdir(dirname(join(libraryDir, path)), { recursive: true });
    await writeFile(join(libraryDir, path), content);
  };
  await write(
    "catalog.json",
    JSON.stringify({
      version: 2,
      savedAt: new Date().toISOString(),
      complete: true,
      items,
    }),
  );
  for (const { name } of items)
    if (name.startsWith("synthetic") || name === "lt-fixture")
      await write(`posters/${name}.png`, poster);
  for (const [name, target, content] of [
    ["lt-fixture", "compositions/lt-fixture.html", bar],
    ["fx-fixture", "compositions/components/fx-fixture.html", fragment],
    ["tr-fixture", "compositions/tr-fixture.html", wipe],
  ] as const) {
    await write(`items/${name}/${target}`, content);
    await write(
      `items/${name}/.files.json`,
      JSON.stringify({ files: [{ target, sha256: sha256(content) }] }),
    );
  }
}
