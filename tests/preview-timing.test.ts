import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previewDependencies } from "../src/server/hyperframes/previewTiming";
import { test, expect, spyOn } from "bun:test";
import { Hono } from "hono";
import * as timingWork from "../src/server/hyperframes/previewTiming";
import * as hyperframes from "@hyperframes/studio-server";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createProjectStore } from "../src/server/projects/store";
import { createReviewService } from "../src/server/projects/review";
import {
  liveUpdatePlan,
  previewDocument,
} from "../src/server/hyperframes/previewBridge";
import { titleAttributes, titleStyle } from "../src/server/timeline/titles";
import { defaultTitle } from "../src/shared/timeline/title";
import { PreviewTimingSchema } from "../src/shared/preview";
import { z } from "zod";

test("concurrent timing readers share approval when the compiled cache cannot finalize", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-shared-timing-"));
  const persisted = await createProjectStore({
    dataDir: root,
    projectsDir: join(root, "projects"),
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let block = false;
  const store = {
    ...persisted,
    async document(...args: Parameters<typeof persisted.document>) {
      const document = await persisted.document(...args);
      if (block) {
        block = false;
        entered.resolve();
        await release.promise;
      }
      return document;
    },
  };
  const editor = createHyperframesApi(store, createReviewService(store));
  const app = new Hono().route("/api", editor);
  const signed = Promise.withResolvers<void>();
  let observeSignature = false;
  const signature = hyperframes.createProjectSignatureAsync;
  const signatureSpy = spyOn(
    hyperframes,
    "createProjectSignatureAsync",
  ).mockImplementation(async (...args) => {
    const result = await signature(...args);
    if (observeSignature) signed.resolve();
    return result;
  });
  try {
    const project = await store.create({
      name: "Shared timing",
      width: 320,
      height: 240,
      duration: 4,
    });
    const path = join(project.path, "index.html");
    const html =
      '<html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="4"><div id="title" class="clip" data-start="0" data-duration="2">Words</div></main></body></html>';
    await writeFile(path, html);
    const load = async (document: string) => {
      const redirect = await app.request(
        `/api/projects/${project.id}/isolated-preview?document=${document}`,
      );
      const url = redirect.headers.get("location")!;
      expect(
        (
          await app.request(url, {
            headers: {
              "sec-fetch-dest": "iframe",
              "sec-fetch-site": "same-origin",
            },
          })
        ).status,
      ).toBe(200);
      expect(
        await (await app.request(`${url}&cutroom-status=1`)).json(),
      ).toEqual({ allowed: true });
      return url;
    };
    const urls = await Promise.all([load("one"), load("two")]);
    await writeFile(path, html.replace('data-start="0"', 'data-start="1"'));
    block = true;
    const first = app.request(`${urls[0]}&cutroom-timing=1`);
    await entered.promise;
    observeSignature = true;
    const second = app.request(`${urls[1]}&cutroom-timing=1`);
    await signed.promise;
    // App metadata changes the upstream cache key, but not the canonical picture.
    const settings = join(project.path, "cutroom.json");
    await writeFile(settings, (await readFile(settings, "utf8")) + "\n");
    release.resolve();
    const body = z.object({
      live: z.literal(true),
      timing: PreviewTimingSchema.nullable(),
    });
    for (const response of await Promise.all([first, second])) {
      expect(response.status).toBe(200);
      const result = body.parse(await response.json());
      expect(result.timing).not.toBeNull();
      expect(result.timing?.clips[0]?.values["data-start"]).toBe("1");
    }
  } finally {
    release.resolve();
    signatureSpy.mockRestore();
    await editor.dispose();
    await persisted.close();
    await rm(root, { recursive: true, force: true });
  }
});

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

/** What a loaded `before` document does when `after` is saved: reload, or the in-place plan. */
const liveChange = (before: string, after: string) => {
  const [from, to] = [snapshot(before), snapshot(after)];
  if (from.structure !== to.structure) return "reload";
  const plan = liveUpdatePlan(from.clips, to.clips);
  return "refuse" in plan ? "reload" : plan;
};

for (const [name, change] of [
  ["script", source.replace("answer=42", "answer=43")],
  ["CSS", source.replace("position:absolute", "position:fixed")],
  ["source", source.replace('src="a.mp4"', 'src="b.mp4"')],
  ["stacking", source.replace('id="v"', 'id="v" data-track-index="2"')],
  ["text", source.replace("Words", "Other")],
  [
    "sub-composition",
    source.replace(
      'id="title"',
      'id="title" data-composition-src="nested.html"',
    ),
  ],
  ["order", source.replace(/(<video.*?<\/video>)(<audio.*?<\/audio>)/, "$2$1")],
] as const)
  test(`${name} changes require a fresh document`, () => {
    expect(liveChange(source, change)).toBe("reload");
  });

test("removing clips and changing the composition's length keep the loaded document", () => {
  const shorter = source
    .replace(/<audio.*?<\/audio>/, "")
    .replace('data-duration="10"', 'data-duration="7.5"');
  expect(liveChange(source, shorter)).toEqual({ remove: ["a"] });
  expect(snapshot(shorter).duration).toBe("7.5");
  // Undo adds the clip back, which needs a fresh document until additions are live.
  expect(liveChange(shorter, source)).toBe("reload");
});

test("a removed clip takes the whitespace before it, so indented sources stay live", () => {
  const indented = source.replace(/(<video|<audio|<div)/g, "\n    $1");
  const lifted = indented.replace(/\n {4}<audio.*?<\/audio>/, "");
  expect(liveChange(indented, lifted)).toEqual({ remove: ["a"] });
  expect(snapshot(indented).clips.map(({ space }) => space)).toEqual([
    "\n    ",
    "\n    ",
    "\n    ",
  ]);
  // Whitespace left behind is structure: it would draw differently in some layouts.
  const leftBehind = indented.replace(/<audio.*?<\/audio>/, "");
  expect(liveChange(indented, leftBehind)).toBe("reload");
});

test("a clip holding a stylesheet is structure, so CSS inside it reloads", () => {
  const styled = (css: string) =>
    source.replace("Words</div>", `<style>${css}</style>Words</div>`);
  const before = styled("main{background:#111}");
  expect(snapshot(before).clips.find(({ id }) => id === "title")?.slot).toBe(
    null,
  );
  expect(
    liveChange(
      before,
      styled(
        "video{animation:spin 2s infinite}@keyframes spin{to{rotate:1turn}}",
      ),
    ),
  ).toBe("reload");
  expect(liveChange(before, before.replace(/<div.*?<\/div>/, ""))).toBe(
    "reload",
  );
});

test("a clip holding another clip or a composition is structure, not a movable clip", () => {
  const holding = source
    .replace(/ id="(v|a|title)"/g, ' id="$1" data-hf-cutroom-clip-id="$1"')
    .replace(
      "Words</div>",
      'Words<span data-hf-cutroom-clip-id="inner" data-start="0" data-duration="1"></span></div>',
    );
  expect(snapshot(holding).clips.find(({ id }) => id === "title")?.slot).toBe(
    null,
  );
  expect(liveChange(holding, holding.replace(/<div.*?<\/div>/, ""))).toBe(
    "reload",
  );
});

test("generated HF ids do not force reloads, but ids used by scripts or CSS do", () => {
  const generated = source.replace('id="v"', 'data-hf-id="hf-old" id="v"');
  expect(snapshot(generated).structure).toBe(
    snapshot(generated.replace("hf-old", "hf-new")).structure,
  );
  const referenced = generated.replace("answer=42", 'answer="hf-old"');
  expect(
    liveChange(
      referenced,
      referenced.replace('data-hf-id="hf-old"', 'data-hf-id="hf-new"'),
    ),
  ).toBe("reload");
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

const titleSource = (font: string | null = null) => {
  const attrs = titleAttributes(
    { ...defaultTitle({ num: 30, den: 1 }), font },
    { num: 30, den: 1 },
  )
    .flatMap(([name, value]) => (value === null ? [] : [`${name}="${value}"`]))
    .join(" ");
  return `<html><head><style>@font-face{font-family:Test;src:url(test.woff2)}</style>${titleStyle(font ? [font] : [])}</head><body><main data-composition-id="main" data-duration="10" data-fps="30"><div id="title" class="clip" data-start="1" data-duration="4" ${attrs}>A &amp; B<br>&lt;script&gt;words&lt;/script&gt;</div></main></body></html>`;
};

test("title snapshots carry the exact validated attribute and decoded text values; only the generated font rules may change", () => {
  const source = titleSource();
  const before = snapshot(source);
  const changed = snapshot(
    source
      .replace('data-title-size="64px"', 'data-title-size="96px"')
      .replace("A &amp; B", "C &lt; D"),
  );
  expect(changed.structure).toBe(before.structure);
  expect(changed.revision).not.toBe(before.revision);
  expect(changed.clips[0]?.title?.attributes).toContainEqual([
    "data-title-size",
    "96px",
  ]);
  expect(changed.clips[0]?.title?.text).toEqual([
    "C < D",
    { br: null },
    "<script>words</script>",
  ]);
  expect(changed.titleStyle).toBe(before.titleStyle);
  const font = snapshot(titleSource("Test"));
  expect(font.structure).toBe(before.structure);
  expect(font.revision).not.toBe(before.revision);
  expect(font.titleStyle).toContain(
    '[data-title-font="Test"]{font-family:"Test",sans-serif}',
  );
});

test("compiled title rules may share a sheet, but surrounding CSS, conditions and referenced break identities remain significant", () => {
  const merged = (font: string | null = null) =>
    titleSource(font).replace(
      titleStyle(font ? [font] : []),
      `<style>.before{color:red}\n${titleStyle(font ? [font] : [])
        .replace(/^<style[^>]*>|<\/style>$/g, "")
        .trim()}\n.after{color:blue}</style>`,
    );
  const before = snapshot(merged());
  expect(before.clips[0]?.title).not.toBeNull();
  expect(snapshot(merged("Test")).structure).toBe(before.structure);
  expect(
    snapshot(merged().replace("color:blue", "color:green")).structure,
  ).not.toBe(before.structure);
  expect(
    snapshot(merged().replace("<style>.before", '<style media="print">.before'))
      .clips[0]?.title,
  ).toBeNull();
  const br = merged().replace("<br>", '<br data-hf-id="break-id">');
  expect(snapshot(br).clips[0]?.title?.text).toEqual([
    "A & B",
    { br: "break-id" },
    "<script>words</script>",
  ]);
  expect(
    snapshot(br.replace(".before{", '[data-hf-id="break-id"]{')).clips[0]
      ?.title,
  ).toBeNull();
});

for (const [name, transform] of [
  [
    "invalid attribute",
    (s: string) =>
      s.replace(
        'data-title-color="#ffffff"',
        'data-title-color="red;position:fixed"',
      ),
  ],
  [
    "undeclared font",
    (s: string) =>
      s.replace(
        'data-title-size="64px"',
        'data-title-size="64px" data-title-font="Unknown"',
      ),
  ],
  ["markup", (s: string) => s.replace("A &amp; B", "<span>A &amp; B</span>")],
  [
    "empty words",
    (s: string) =>
      s.replace("A &amp; B<br>&lt;script&gt;words&lt;/script&gt;", ""),
  ],
  [
    "styled break",
    (s: string) => s.replace("<br>", '<br style="display:none">'),
  ],
  [
    "managed CSS",
    (s: string) => s.replace("line-height:1.15", "line-height:2"),
  ],
  [
    "stylesheet version",
    (s: string) =>
      s.replace('data-cutroom-titles="1"', 'data-cutroom-titles="2"'),
  ],
  [
    "duplicate stylesheet",
    (s: string) => s.replace("</head>", titleStyle([]) + "</head>"),
  ],
  [
    "inert stylesheet",
    (s: string) =>
      s.replace(titleStyle([]), `<template>${titleStyle([])}</template>`),
  ],
  [
    "title version",
    (s: string) =>
      s.replace('data-cutroom-title="1"', 'data-cutroom-title="2"'),
  ],
] as const)
  test(`${name} cannot enter the live title contract`, () => {
    const changed = snapshot(transform(titleSource()));
    expect(changed.structure).not.toBe(snapshot(titleSource()).structure);
    expect(changed.clips[0]?.title).toBeNull();
    expect(changed.titleStyle).toBeNull();
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

test("a compile whose source changes after signing cannot approve the signed version", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-stale-sign-"));
  const store = await createProjectStore({
    dataDir: root,
    projectsDir: join(root, "projects"),
  });
  const editor = createHyperframesApi(store, createReviewService(store));
  const app = new Hono().route("/api", editor);
  let afterSignature: (() => Promise<void>) | null = null;
  const signature = hyperframes.createProjectSignatureAsync;
  const spy = spyOn(
    hyperframes,
    "createProjectSignatureAsync",
  ).mockImplementation(async (...args) => {
    const result = await signature(...args);
    const hook = afterSignature;
    afterSignature = null;
    await hook?.();
    return result;
  });
  try {
    const project = await store.create({
      name: "Stale signature",
      width: 320,
      height: 240,
      duration: 4,
    });
    const path = join(project.path, "index.html");
    const plain =
      '<html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="4"><div id="title" class="clip" data-start="0" data-duration="2">Words</div></main></body></html>';
    const scripted = plain.replace(
      "</main>",
      "</main><script>document.body.dataset.authored='1'</script>",
    );
    const iframe = {
      headers: { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" },
    };
    const previewUrl = async (document: string, query = "") =>
      (
        await app.request(
          `/api/projects/${project.id}/isolated-preview?document=${document}${query}`,
        )
      ).headers.get("location")!;

    // The scripted version sits in the upstream compiled cache.
    await writeFile(path, scripted);
    expect((await app.request(await previewUrl("warm"))).status).toBe(200);

    // A capture compile signs the scripted version, then the plain one lands before the compiler reads.
    afterSignature = () => writeFile(path, plain);
    expect(
      (await app.request(await previewUrl("capture", "&hf-capture=1"))).status,
    ).toBe(200);

    const loaded = await previewUrl("loaded");
    expect((await app.request(loaded, iframe)).status).toBe(200);
    expect(
      await (await app.request(`${loaded}&cutroom-status=1`)).json(),
    ).toEqual({ allowed: true });

    // Undo back to the cached scripted version: it must not be treated as script-free.
    await writeFile(path, scripted);
    const timing = (await (
      await app.request(`${loaded}&cutroom-timing=1`)
    ).json()) as { timing: unknown };
    expect(timing.timing).toBeNull();
  } finally {
    spy.mockRestore();
    await editor.dispose();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("media cache writes during a compile keep live timing for the opening tab and a tab sharing the compile", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-app-state-"));
  const store = await createProjectStore({
    dataDir: root,
    projectsDir: join(root, "projects"),
  });
  const editor = createHyperframesApi(store, createReviewService(store));
  const app = new Hono().route("/api", editor);
  // Each hook runs once, on the next signature computation, before or after it.
  let beforeSignature: (() => Promise<void>) | null = null;
  let afterSignature: (() => Promise<void>) | null = null;
  const signature = hyperframes.createProjectSignatureAsync;
  const spy = spyOn(
    hyperframes,
    "createProjectSignatureAsync",
  ).mockImplementation(async (...args) => {
    const before = beforeSignature;
    beforeSignature = null;
    await before?.();
    const result = await signature(...args);
    const after = afterSignature;
    afterSignature = null;
    await after?.();
    return result;
  });
  try {
    const project = await store.create({
      name: "App state",
      width: 320,
      height: 240,
      duration: 4,
    });
    const path = join(project.path, "index.html");
    const html =
      '<html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="4"><div id="title" class="clip" data-start="0" data-duration="2">Words</div></main></body></html>';
    await writeFile(path, html);
    let frames = 0;
    const cacheFrame = async () => {
      await mkdir(join(project.path, ".cutroom", "cache", "frames"), {
        recursive: true,
      });
      await writeFile(
        join(project.path, ".cutroom", "cache", "frames", `${++frames}.png`),
        "frame",
      );
    };
    const load = async (document: string) => {
      const redirect = await app.request(
        `/api/projects/${project.id}/isolated-preview?document=${document}`,
      );
      const url = redirect.headers.get("location")!;
      const response = await app.request(url, {
        headers: {
          "sec-fetch-dest": "iframe",
          "sec-fetch-site": "same-origin",
        },
      });
      expect(response.status).toBe(200);
      return url;
    };
    const approved = async (url: string) =>
      (await (await app.request(`${url}&cutroom-status=1`)).json()) as {
        allowed: boolean;
      };

    // Opening a project extracts filmstrip frames while its first document compiles.
    afterSignature = cacheFrame;
    const opened = await load("opened");
    expect(frames).toBe(1);
    expect(await approved(opened)).toEqual({ allowed: true });

    const first = await load("first");
    const second = await load("second");
    for (const url of [first, second])
      expect(await approved(url)).toEqual({ allowed: true });

    // Both tabs read one timing edit. The first compiles it; the second signs the same
    // source and shares that compile. A cache write lands before the compile is checked.
    await writeFile(path, html.replace('data-start="0"', 'data-start="1"'));
    const checking = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const shared = Promise.withResolvers<void>();
    afterSignature = async () => {
      beforeSignature = async () => {
        checking.resolve();
        await release.promise;
      };
    };
    const firstTiming = app.request(`${first}&cutroom-timing=1`);
    await checking.promise;
    afterSignature = async () => shared.resolve();
    const secondTiming = app.request(`${second}&cutroom-timing=1`);
    await shared.promise;
    await cacheFrame();
    release.resolve();
    for (const response of await Promise.all([firstTiming, secondTiming])) {
      expect(response.status).toBe(200);
      const result = z
        .object({ live: z.literal(true), timing: PreviewTimingSchema })
        .parse(await response.json());
      expect(result.timing.clips[0]?.values["data-start"]).toBe("1");
    }
  } finally {
    spy.mockRestore();
    await editor.dispose();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
