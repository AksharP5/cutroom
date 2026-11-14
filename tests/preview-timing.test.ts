import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previewDependencies } from "../src/server/hyperframes/previewTiming";
import { test, expect } from "bun:test";
import { previewDocument } from "../src/server/hyperframes/previewBridge";

const source = `<html><head><style>video { position:absolute }</style></head><body><main data-composition-id="main" data-fps="30000/1001" data-duration="10"><video id="v" data-start="0" data-duration="2.535867" data-media-start="0" src="a.mp4" data-link="pair"></video><audio id="a" data-start="0" data-duration="2.535867" data-media-start="0" src="a.mp4" data-link="pair"></audio><div id="title" class="clip" data-start="0" data-duration="2">Words</div></main><script>window.answer=42</script></body></html>`;

test("saved timing snapshots use the fresh preview's rational boundaries and include linked partners", () => {
  const before = previewDocument(source).timing;
  const after = previewDocument(
    source
      .replaceAll('data-start="0"', 'data-start="0.033367"')
      .replaceAll('data-media-start="0"', 'data-media-start="1"'),
  ).timing;
  expect(after.structure).toBe(before.structure);
  expect(after.revision).not.toBe(before.revision);
  expect(after.clips.map((clip) => clip.id)).toEqual(["v", "a", "title"]);
  expect(Number(after.clips[0]!.values["data-start"])).toBe(1001 / 30000);
  expect(after.clips[0]!.values).toEqual(after.clips[1]!.values);
});

for (const [name, change] of [
  ["script", source.replace("answer=42", "answer=43")],
  ["CSS", source.replace("position:absolute", "position:fixed")],
  ["source", source.replace('src="a.mp4"', 'src="b.mp4"')],
  ["stacking", source.replace('id="v"', 'id="v" data-track-index="2"')],
  [
    "addition",
    source.replace(
      "</main>",
      '<div class="clip" data-start="0" data-duration="1">New</div></main>',
    ),
  ],
  ["removal", source.replace(/<video.*?<\/video>/, "")],
  ["text", source.replace("Words", "Other")],
  ["root duration", source.replace('data-duration="10"', 'data-duration="11"')],
  [
    "sub-composition",
    source.replace(
      'id="title"',
      'id="title" data-composition-src="nested.html"',
    ),
  ],
] as const)
  test(`${name} changes require a fresh document`, () => {
    expect(previewDocument(change).timing.structure).not.toBe(
      previewDocument(source).timing.structure,
    );
  });

test("generated HF ids do not force reloads, but ids used by scripts or CSS do", () => {
  const generated = source.replace('id="v"', 'data-hf-id="hf-old" id="v"');
  expect(previewDocument(generated).timing.structure).toBe(
    previewDocument(generated.replace("hf-old", "hf-new")).timing.structure,
  );
  const referenced = generated.replace("answer=42", 'answer="hf-old"');
  expect(previewDocument(referenced).timing.structure).not.toBe(
    previewDocument(
      referenced.replace('data-hf-id="hf-old"', 'data-hf-id="hf-new"'),
    ).timing.structure,
  );
});

test("the signature of other project files belongs to the document revision", () => {
  expect(
    previewDocument(source, "index.html", "before").timing.structure,
  ).not.toBe(previewDocument(source, "index.html", "after").timing.structure);
});

test("app state does not invalidate timing, but other source files do", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cutroom-preview-timing-"));
  try {
    await mkdir(join(dir, ".cutroom"));
    await writeFile(join(dir, "index.html"), source);
    await writeFile(join(dir, "scene.html"), "Original scene");
    const before = await previewDependencies(dir, "index.html");
    await writeFile(
      join(dir, "index.html"),
      source.replace('data-start="0"', 'data-start="1"'),
    );
    await writeFile(join(dir, "cutroom.json"), "{}");
    await writeFile(join(dir, ".cutroom", "ids.json"), '["new-id"]');
    expect(await previewDependencies(dir, "index.html")).toBe(before);
    await writeFile(join(dir, "scene.html"), "Changed scene");
    expect(await previewDependencies(dir, "index.html")).not.toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
