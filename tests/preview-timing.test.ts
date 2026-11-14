import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previewDependencies } from "../src/server/hyperframes/previewTiming";
import { test, expect, spyOn } from "bun:test";
import { Hono } from "hono";
import * as timingWork from "../src/server/hyperframes/previewTiming";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createProjectStore } from "../src/server/projects/store";
import { createReviewService } from "../src/server/projects/review";
import { previewDocument } from "../src/server/hyperframes/previewBridge";

const snapshot = (html: string, dependencies = "") => {
  const { timing } = previewDocument(html, "index.html", dependencies);
  if (!timing)
    throw new Error("Expected an explicitly enabled timing snapshot");
  return timing;
};

const source = `<html><head><style>video { position:absolute }</style></head><body><main data-composition-id="main" data-fps="30000/1001" data-duration="10"><video id="v" data-start="0" data-duration="2.535867" data-media-start="0" src="a.mp4" data-link="pair"></video><audio id="a" data-start="0" data-duration="2.535867" data-media-start="0" src="a.mp4" data-link="pair"></audio><div id="title" class="clip" data-start="0" data-duration="2">Words</div></main><script>window.answer=42</script></body></html>`;

test("saved timing snapshots use the fresh preview's rational boundaries and include linked partners", () => {
  const before = snapshot(source);
  const after = snapshot(
    source
      .replaceAll('data-start="0"', 'data-start="0.033367"')
      .replaceAll('data-media-start="0"', 'data-media-start="1"'),
  );
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
    expect(snapshot(change).structure).not.toBe(snapshot(source).structure);
  });

test("generated HF ids do not force reloads, but ids used by scripts or CSS do", () => {
  const generated = source.replace('id="v"', 'data-hf-id="hf-old" id="v"');
  expect(snapshot(generated).structure).toBe(
    snapshot(generated.replace("hf-old", "hf-new")).structure,
  );
  const referenced = generated.replace("answer=42", 'answer="hf-old"');
  expect(snapshot(referenced).structure).not.toBe(
    snapshot(referenced.replace('data-hf-id="hf-old"', 'data-hf-id="hf-new"'))
      .structure,
  );
});

test("a Cutroom track fader travels with the timing update, but an authored group's fader reloads", () => {
  const grouped = source.replace(
    "</main>",
    '<hf-audio-group id="cutroom-a1" data-cutroom-track="1" data-volume="1"></hf-audio-group><hf-audio-group id="bus" data-volume="1"></hf-audio-group></main>',
  );
  expect(
    snapshot(
      grouped.replace(
        'data-track="1" data-volume="1"',
        'data-track="1" data-volume="0.5"',
      ),
    ).structure,
  ).toBe(snapshot(grouped).structure);
  expect(
    snapshot(
      grouped.replace('id="bus" data-volume="1"', 'id="bus" data-volume="0.5"'),
    ).structure,
  ).not.toBe(snapshot(grouped).structure);
});

test("the signature of other project files belongs to the document revision", () => {
  expect(snapshot(source, "before").structure).not.toBe(
    snapshot(source, "after").structure,
  );
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

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "unavailable fingerprints disable timing without preventing the full document",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "cutroom-fingerprint-"));
    const aux = join(dir, "aux");
    await mkdir(aux);
    await writeFile(join(aux, "unused.tmp"), "temporary");
    await chmod(aux, 0o400);
    try {
      const dependencies = await previewDependencies(dir, "index.html");
      expect(dependencies).toBeNull();
      const html =
        '<html><body><main data-composition-id="main" data-duration="4"><div id="title" class="clip" data-start="0" data-duration="4">Words</div></main></body></html>';
      expect(
        previewDocument(html, "index.html", "stable").timing,
      ).not.toBeNull();
      const full = previewDocument(html, "index.html", dependencies);
      expect(full.timing).toBeNull();
      expect(full.html).toContain("Words");
    } finally {
      await chmod(aux, 0o700);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("scripted preview responses skip dependency and timing work, including forged markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-reload-only-"));
  const store = await createProjectStore({
    dataDir: root,
    projectsDir: join(root, "projects"),
  });
  const editor = createHyperframesApi(store, createReviewService(store));
  const app = new Hono().route("/api", editor);
  // Spies call the real implementations. The eligible response below proves the
  // counters observe the same bindings used by the HTTP pipeline.
  const dependencies = spyOn(timingWork, "previewDependencies");
  const snapshot = spyOn(timingWork, "previewTiming");
  try {
    const project = await store.create({
      name: "Reload only",
      width: 320,
      height: 240,
      duration: 4,
    });
    const path = join(project.path, "index.html");
    const html =
      '<html><head><meta name="cutroom-timing-contract" content="attributes"></head><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="4"><div id="title" class="clip" data-start="0" data-duration="4">Words</div></main></body></html>';
    const preview = async (document: string) => {
      const redirect = await app.request(
        `/api/projects/${project.id}/isolated-preview?document=${document}`,
      );
      const response = await app.request(redirect.headers.get("location")!, {
        headers: {
          "sec-fetch-dest": "iframe",
          "sec-fetch-site": "same-origin",
        },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("Words");
      expect(text).toContain(
        '<meta name="cutroom-timing-contract" content="attributes">',
      );
    };
    await writeFile(
      path,
      html.replace("</body>", "<script>window.authored=true</script></body>"),
    );
    await preview("scripted");
    expect(dependencies).toHaveBeenCalledTimes(0);
    expect(snapshot).toHaveBeenCalledTimes(0);
    await writeFile(path, html);
    await preview("eligible");
    expect(dependencies).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
  } finally {
    dependencies.mockRestore();
    snapshot.mockRestore();
    await editor.dispose();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
