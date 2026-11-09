import { expect, test } from "bun:test";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSourceDocument } from "@hyperframes/studio-server";
import {
  ProjectDocumentSchema,
  ProjectNotebookSchema,
  TranscriptSchema,
} from "../src/shared/project";
import { createTranscriptService } from "../src/server/transcript/service";
import { listMedia } from "../src/server/projects/media";
import { projectFixture } from "./project-fixture";

const source = `<!doctype html><html><head><style>#footage{position:absolute;width:100%;height:100%;object-fit:cover}</style></head><body><main data-composition-id="main" data-width="1920" data-height="1080" data-duration="14"><video id="footage" class="clip" src="footage.mp4" data-start="0" data-duration="10" data-track-index="0" data-media-start="2"></video><video id="following" class="clip" src="footage.mp4" data-start="10" data-duration="4" data-track-index="0"></video><div id="other-track" class="clip" data-start="8" data-duration="2" data-track-index="1">Overlay</div></main></body></html>`;
const words = [
  { id: "one", text: "Keep", start: 2, end: 3 },
  { id: "two", text: "this", start: 3, end: 4 },
  { id: "three", text: "remove", start: 4, end: 5 },
  { id: "four", text: "phrase", start: 5, end: 6 },
  { id: "five", text: "continue", start: 6, end: 7 },
];

test("script cuts alter real media offsets, ripple one lane, restore, and share undo", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "Script cuts" });
    await writeFile(join(project.path, "index.html"), source);
    await writeFile(
      join(project.path, "footage.mp4"),
      "source bytes stay unchanged",
    );
    const imported = await fixture.request(
      `/projects/${project.id}/transcripts/import`,
      "POST",
      { mediaPath: "footage.mp4", elementId: "footage", words },
    );
    expect(imported.status).toBe(201);
    const transcript = TranscriptSchema.parse(await imported.json());
    const cut = await fixture.request(
      `/projects/${project.id}/transcripts/${transcript.id}/cuts`,
      "POST",
      { wordIds: ["three", "four"], action: "cut" },
    );
    expect(cut.status).toBe(200);
    const after = await readFile(join(project.path, "index.html"), "utf8");
    const document = parseSourceDocument(after).document;
    const clips = [
      ...document.querySelectorAll("video[data-cutroom-transcript]"),
    ];
    expect(clips).toHaveLength(2);
    expect(
      clips.map((clip) => [
        Number(clip.getAttribute("data-start")),
        Number(clip.getAttribute("data-duration")),
        Number(clip.getAttribute("data-media-start")),
      ]),
    ).toEqual([
      [0, 2, 2],
      [2, 6, 6],
    ]);
    expect(
      document.querySelector("#following")?.getAttribute("data-start"),
    ).toBe("8");
    expect(
      document.querySelector("#other-track")?.getAttribute("data-start"),
    ).toBe("8");
    expect(
      document
        .querySelector("[data-composition-id]")
        ?.getAttribute("data-duration"),
    ).toBe("12");
    expect(document.querySelector("style")?.textContent).toContain(
      `#${clips[1]!.id}`,
    );
    expect(await readFile(join(project.path, "footage.mp4"), "utf8")).toBe(
      "source bytes stay unchanged",
    );
    expect(
      (await listMedia(project)).find((clip) => clip.elementId === "footage")
        ?.duration,
    ).toBe(8);
    const list = await (
      await fixture.request(`/projects/${project.id}/transcripts`)
    ).json();
    expect(JSON.stringify(list)).toContain('"timelineStart":2');
    expect(
      (await fixture.request(`/projects/${project.id}/history/undo`, "POST"))
        .status,
    ).toBe(200);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      source,
    );
    expect(
      (await fixture.store.document(project)).transcripts[0]?.cutWordIds,
    ).toEqual([]);
    expect(
      (await fixture.request(`/projects/${project.id}/history/redo`, "POST"))
        .status,
    ).toBe(200);
    expect(
      (await fixture.store.document(project)).transcripts[0]?.cutWordIds,
    ).toEqual(["three", "four"]);
    expect(
      (
        await fixture.request(
          `/projects/${project.id}/transcripts/${transcript.id}/cuts`,
          "POST",
          { wordIds: ["three", "four"], action: "restore" },
        )
      ).status,
    ).toBe(200);
    const restored = parseSourceDocument(
      await readFile(join(project.path, "index.html"), "utf8"),
    ).document;
    expect(
      restored.querySelectorAll("video[data-cutroom-transcript]"),
    ).toHaveLength(1);
    expect(
      restored.querySelector("#footage")?.getAttribute("data-duration"),
    ).toBe("10");
    expect(
      restored.querySelector("#footage")?.getAttribute("data-media-start"),
    ).toBe("2");
    expect(
      restored.querySelector("#following")?.getAttribute("data-start"),
    ).toBe("10");
    expect(
      restored
        .querySelector("[data-composition-id]")
        ?.getAttribute("data-duration"),
    ).toBe("14");
  } finally {
    await fixture.close();
  }
});

test("script edits reject unknown words, stale versions, and unsupported linked media", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "Boundary checks" });
    await writeFile(join(project.path, "index.html"), source);
    await writeFile(join(project.path, "footage.mp4"), "original");
    const imported = TranscriptSchema.parse(
      await (
        await fixture.request(
          `/projects/${project.id}/transcripts/import`,
          "POST",
          { mediaPath: "footage.mp4", elementId: "footage", words },
        )
      ).json(),
    );
    const path = `/projects/${project.id}/transcripts/${imported.id}/cuts`;
    expect(
      (
        await fixture.request(path, "POST", {
          wordIds: ["missing"],
          action: "cut",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fixture.request(path, "POST", {
          wordIds: ["three"],
          action: "cut",
          expectedVersion: "stale",
        })
      ).status,
    ).toBe(409);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      source,
    );
    const document = ProjectDocumentSchema.parse(
      await (await fixture.request(`/projects/${project.id}/document`)).json(),
    );
    expect(document.transcripts[0]?.cutWordIds).toEqual([]);
    const linked = await fixture.store.create({ name: "Linked clips" });
    await writeFile(join(linked.path, "footage.mp4"), "media");
    await writeFile(
      join(linked.path, "index.html"),
      source
        .replace('id="footage"', 'id="footage" data-link="pair"')
        .replace('id="following"', 'id="following" data-link="pair"'),
    );
    expect(
      (
        await fixture.request(
          `/projects/${linked.id}/transcripts/import`,
          "POST",
          { mediaPath: "footage.mp4", elementId: "footage", words },
        )
      ).status,
    ).toBe(422);
  } finally {
    await fixture.close();
  }
});

test("moving then fully cutting and restoring a clip preserves its lane, position, and word seeking", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "Moved script" });
    const original =
      '<html><body><main data-composition-id="main" data-duration="14"><video id="speech" class="clip" src="speech.wav" data-start="0" data-duration="4" data-track-index="2"></video><video id="later" class="clip" src="speech.wav" data-start="10" data-duration="4" data-track-index="2"></video><div id="other" data-start="10" data-duration="4" data-track-index="0"></div></main></body></html>';
    await writeFile(join(project.path, "index.html"), original);
    await writeFile(join(project.path, "speech.wav"), "media");
    const service = createTranscriptService(fixture.store);
    const transcript = await service.importTranscript(project, {
      mediaPath: "speech.wav",
      sourceFile: "index.html",
      elementId: "speech",
      language: "en",
      words: [
        { id: "first", text: "First", start: 0, end: 2 },
        { id: "second", text: "second", start: 2, end: 4 },
      ],
    });
    await writeFile(
      join(project.path, "index.html"),
      original.replace('data-start="0"', 'data-start="5"'),
    );
    expect((await service.list(project))[0]?.words[1]?.timelineStart).toBe(7);
    const partiallyCut = await service.cutWords(project, transcript.id, {
      wordIds: ["first"],
      action: "cut",
    });
    expect(partiallyCut.words[1]?.timelineStart).toBe(5);
    expect(
      (await fixture.store.document(project)).transcripts[0]?.original.start,
    ).toBe(5);
    await service.cutWords(project, transcript.id, {
      wordIds: ["second"],
      action: "cut",
    });
    const empty = parseSourceDocument(
      await readFile(join(project.path, "index.html"), "utf8"),
    ).document;
    expect(
      empty.querySelectorAll("video[data-cutroom-transcript]"),
    ).toHaveLength(0);
    expect(empty.querySelector("#later")?.getAttribute("data-start")).toBe("6");
    expect(empty.querySelector("#other")?.getAttribute("data-start")).toBe(
      "10",
    );
    const restored = await service.cutWords(project, transcript.id, {
      wordIds: ["first", "second"],
      action: "restore",
    });
    expect(restored.words[0]?.timelineStart).toBe(5);
    expect(restored.words[1]?.timelineStart).toBe(7);
    const final = parseSourceDocument(
      await readFile(join(project.path, "index.html"), "utf8"),
    ).document;
    expect(final.querySelector("#speech")?.getAttribute("data-start")).toBe(
      "5",
    );
    expect(
      final.querySelector("#speech")?.getAttribute("data-track-index"),
    ).toBe("2");
    expect(final.querySelector("#later")?.getAttribute("data-start")).toBe(
      "10",
    );
    expect(final.querySelector("#other")?.getAttribute("data-start")).toBe(
      "10",
    );
    await service.dispose();
  } finally {
    await fixture.close();
  }
});

const localMedia = process.env.CUTROOM_TRANSCRIBE_TEST_MEDIA;
test.skipIf(!localMedia)(
  "installed local Whisper produces a real word-timed transcript",
  async () => {
    const fixture = await projectFixture();
    try {
      const project = await fixture.store.create({
        name: "Local transcription",
      });
      await writeFile(
        join(project.path, "speech.wav"),
        await readFile(localMedia!),
      );
      await writeFile(
        join(project.path, "index.html"),
        '<html><body><main data-composition-id="main" data-width="1920" data-height="1080" data-duration="12"><audio id="speech" class="clip" src="speech.wav" data-start="0" data-duration="12"></audio></main></body></html>',
      );
      const service = createTranscriptService(fixture.store);
      const job = await service.start(project, {
        mediaPath: "speech.wav",
        sourceFile: "index.html",
        elementId: "speech",
        language: "en",
      });
      const deadline = Date.now() + 120_000;
      while (job.status === "running" && Date.now() < deadline)
        await Bun.sleep(100);
      expect(job.status).toBe("complete");
      const transcripts = await service.list(project);
      expect(transcripts[0]!.words.length).toBeGreaterThan(10);
      expect(
        transcripts[0]!.words.some((word) => /country/i.test(word.text)),
      ).toBe(true);
      await service.dispose();
    } finally {
      await fixture.close();
    }
  },
  150_000,
);

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}

const installedWhisper = {
  available: true,
  binary: "/test/whisper-cli",
  modelsDir: "/test/models",
  models: ["ggml-small.en.bin"],
  model: "small.en",
};

test("transcription admission is exclusive and shutdown prevents a late start", async () => {
  const fixture = await projectFixture();
  const discovery = gate();
  const service = createTranscriptService(fixture.store, {
    availability: async () => {
      await discovery.waiting;
      return installedWhisper;
    },
  });
  try {
    const project = await fixture.store.create({ name: "Admission" });
    await writeFile(join(project.path, "index.html"), source);
    await writeFile(join(project.path, "footage.mp4"), "unchanged source");
    const input = {
      mediaPath: "footage.mp4",
      sourceFile: "index.html",
      elementId: "footage",
      language: "en",
    };
    const first = service.start(project, input);
    await expect(service.start(project, input)).rejects.toThrow(
      "already being transcribed",
    );
    await service.dispose();
    discovery.release();
    await expect(first).rejects.toThrow("shutting down");
    expect((await fixture.store.document(project)).transcripts).toEqual([]);
  } finally {
    discovery.release();
    await service.dispose();
    await fixture.close();
  }
});

test("a cancelled transcription cannot import a late successful engine result", async () => {
  const fixture = await projectFixture();
  const engine = gate();
  const entered = gate();
  const service = createTranscriptService(fixture.store, {
    availability: async () => installedWhisper,
    transcribe: async (options) => {
      if (!options.dir)
        throw new Error("The engine requires a scratch folder.");
      const transcriptPath = join(options.dir, "transcript.json");
      await writeFile(transcriptPath, JSON.stringify(words));
      entered.release();
      await engine.waiting;
      return {
        kind: "transcribed",
        engine: "whisper",
        model: "small.en",
        detectedLanguage: "en",
        wordCount: words.length,
        durationSeconds: 10,
        speechOnsetSeconds: 2,
        transcriptPath,
      };
    },
  });
  try {
    const project = await fixture.store.create({ name: "Late transcription" });
    await writeFile(join(project.path, "index.html"), source);
    await writeFile(join(project.path, "footage.mp4"), "unchanged source");
    const job = await service.start(project, {
      mediaPath: "footage.mp4",
      sourceFile: "index.html",
      elementId: "footage",
      language: "en",
    });
    await entered.waiting;
    service.cancel(job.id);
    engine.release();
    await service.dispose();
    expect(service.getJob(job.id).status).toBe("cancelled");
    expect((await fixture.store.document(project)).transcripts).toEqual([]);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      source,
    );
  } finally {
    engine.release();
    await service.dispose();
    await fixture.close();
  }
});

test("a cancelled transcript import waiting for a history transaction makes no edit", async () => {
  const fixture = await projectFixture();
  const service = createTranscriptService(fixture.store);
  const blocker = gate();
  const entered = gate();
  try {
    const project = await fixture.store.create({ name: "Queued transcript" });
    await writeFile(join(project.path, "index.html"), source);
    await writeFile(join(project.path, "footage.mp4"), "unchanged source");
    const holding = fixture.store.mutate(
      project,
      "In-flight edit",
      async () => {
        entered.release();
        await blocker.waiting;
      },
    );
    await entered.waiting;
    const controller = new AbortController();
    const pending = service.importTranscript(
      project,
      {
        mediaPath: "footage.mp4",
        sourceFile: "index.html",
        elementId: "footage",
        language: "en",
        words,
      },
      controller.signal,
    );
    controller.abort();
    blocker.release();
    await holding;
    await expect(pending).rejects.toThrow();
    expect((await fixture.store.document(project)).transcripts).toEqual([]);
  } finally {
    blocker.release();
    await service.dispose();
    await fixture.close();
  }
});

test("notebook refreshes exclude transcript words and only revise when script data changes", async () => {
  const fixture = await projectFixture();
  try {
    const project = await fixture.store.create({ name: "Compact notebook" });
    await writeFile(join(project.path, "index.html"), source);
    await writeFile(join(project.path, "footage.mp4"), "unchanged source");
    const service = createTranscriptService(fixture.store);
    const transcript = await service.importTranscript(project, {
      mediaPath: "footage.mp4",
      sourceFile: "index.html",
      elementId: "footage",
      language: "en",
      words,
    });
    const before = ProjectNotebookSchema.strict().parse(
      await (await fixture.request(`/projects/${project.id}/notebook`)).json(),
    );
    expect(Object.keys(before).sort()).toEqual([
      "annotations",
      "transcriptVersion",
    ]);
    await fixture.request(`/projects/${project.id}/annotations`, "POST", {
      kind: "comment",
      body: "A new note",
      time: 0,
    });
    const annotated = ProjectNotebookSchema.strict().parse(
      await (await fixture.request(`/projects/${project.id}/notebook`)).json(),
    );
    expect(annotated.annotations).toHaveLength(1);
    expect(annotated.transcriptVersion).toBe(before.transcriptVersion);
    await service.cutWords(project, transcript.id, {
      wordIds: ["three"],
      action: "cut",
    });
    const cut = ProjectNotebookSchema.strict().parse(
      await (await fixture.request(`/projects/${project.id}/notebook`)).json(),
    );
    expect(cut.transcriptVersion).not.toBe(before.transcriptVersion);
    expect(
      (await fixture.store.document(project)).transcripts[0]?.words,
    ).toHaveLength(words.length);
    await service.dispose();
  } finally {
    await fixture.close();
  }
});

test("transcript views share a current source snapshot and refresh after outside moves", async () => {
  const fixture = await projectFixture();
  const service = createTranscriptService(fixture.store);
  try {
    const project = await fixture.store.create({
      name: "Fresh transcript views",
    });
    await writeFile(join(project.path, "index.html"), source);
    await writeFile(join(project.path, "footage.mp4"), "unchanged source");
    const first = await service.importTranscript(project, {
      mediaPath: "footage.mp4",
      sourceFile: "index.html",
      elementId: "footage",
      language: "en",
      words,
    });
    await service.importTranscript(project, {
      mediaPath: "footage.mp4",
      sourceFile: "index.html",
      elementId: "following",
      language: "en",
      words: [{ id: "next", text: "Next", start: 0, end: 1 }],
    });
    expect(
      (await service.list(project)).map((item) => item.words[0]?.timelineStart),
    ).toEqual([0, 10]);
    await writeFile(
      join(project.path, "index.html"),
      source
        .replace('data-start="10"', 'data-start="12"')
        .replace('data-start="0"', 'data-start="3"'),
    );
    expect(
      (await service.list(project)).map((item) => item.words[0]?.timelineStart),
    ).toEqual([3, 12]);
    const unchanged = await service.cutWords(project, first.id, {
      wordIds: ["one"],
      action: "restore",
    });
    expect(unchanged.words[0]?.timelineStart).toBe(3);
  } finally {
    await service.dispose();
    await fixture.close();
  }
});

test("script cuts ripple implicit track zero without moving a nested scene's internal clips", async () => {
  const fixture = await projectFixture();
  const service = createTranscriptService(fixture.store);
  try {
    const project = await fixture.store.create({ name: "Nested lane timing" });
    const html =
      '<html><body><main data-composition-id="main" data-width="1920" data-height="1080" data-duration="15"><video id="speech" src="speech.mp4" class="clip" data-start="0" data-duration="4"></video><div id="later" class="clip" data-start="4" data-duration="1"></div><section id="scene" class="clip" data-start="10" data-duration="5"><div id="inside" class="clip" data-start="2" data-duration="2"></div></section></main></body></html>';
    await writeFile(join(project.path, "index.html"), html);
    await writeFile(join(project.path, "speech.mp4"), "unchanged source");
    const transcript = await service.importTranscript(project, {
      mediaPath: "speech.mp4",
      sourceFile: "index.html",
      elementId: "speech",
      language: "en",
      words: [{ id: "cut", text: "cut", start: 1, end: 2 }],
    });
    await service.cutWords(project, transcript.id, {
      wordIds: ["cut"],
      action: "cut",
    });
    const document = parseSourceDocument(
      await readFile(join(project.path, "index.html"), "utf8"),
    ).document;
    expect(document.querySelector("#later")?.getAttribute("data-start")).toBe(
      "3",
    );
    expect(document.querySelector("#scene")?.getAttribute("data-start")).toBe(
      "9",
    );
    expect(document.querySelector("#inside")?.getAttribute("data-start")).toBe(
      "2",
    );
    await service.cutWords(project, transcript.id, {
      wordIds: ["cut"],
      action: "restore",
    });
    const restored = parseSourceDocument(
      await readFile(join(project.path, "index.html"), "utf8"),
    ).document;
    expect(restored.querySelector("#scene")?.getAttribute("data-start")).toBe(
      "10",
    );
    expect(restored.querySelector("#inside")?.getAttribute("data-start")).toBe(
      "2",
    );
  } finally {
    await service.dispose();
    await fixture.close();
  }
});

test("script changes preserve outside source-offset and nested-source edits by refusing ambiguous cuts", async () => {
  const fixture = await projectFixture();
  const service = createTranscriptService(fixture.store);
  try {
    const project = await fixture.store.create({
      name: "Preserve independent media edits",
    });
    const html = source
      .replace('src="footage.mp4" data-start="0"', 'data-start="0"')
      .replace(
        'data-media-start="2"></video>',
        'data-media-start="2"><source src="footage.mp4"></video>',
      );
    await writeFile(join(project.path, "index.html"), html);
    await writeFile(join(project.path, "footage.mp4"), "unchanged source");
    const transcript = await service.importTranscript(project, {
      mediaPath: "footage.mp4",
      sourceFile: "index.html",
      elementId: "footage",
      language: "en",
      words,
    });
    const trimmed = html.replace(
      'data-media-start="2"',
      'data-media-start="3"',
    );
    await writeFile(join(project.path, "index.html"), trimmed);
    await expect(
      service.cutWords(project, transcript.id, {
        wordIds: ["three"],
        action: "cut",
      }),
    ).rejects.toThrow("timing changed outside Script");
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      trimmed,
    );
    const replaced = html.replace(
      '<source src="footage.mp4">',
      '<source src="replacement.mp4">',
    );
    await writeFile(join(project.path, "index.html"), replaced);
    await expect(
      service.cutWords(project, transcript.id, {
        wordIds: ["three"],
        action: "cut",
      }),
    ).rejects.toThrow("source or playback rate changed");
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      replaced,
    );
  } finally {
    await service.dispose();
    await fixture.close();
  }
});

test("script cuts recheck links and animation added after transcript import", async () => {
  const fixture = await projectFixture();
  const service = createTranscriptService(fixture.store);
  try {
    const project = await fixture.store.create({ name: "Late media links" });
    await writeFile(join(project.path, "index.html"), source);
    await writeFile(join(project.path, "footage.mp4"), "unchanged source");
    const transcript = await service.importTranscript(project, {
      sourceFile: "index.html",
      mediaPath: "footage.mp4",
      elementId: "footage",
      language: "en",
      words,
    });
    const linked = source
      .replace('id="footage"', 'id="footage" data-link="pair"')
      .replace('id="following"', 'id="following" data-link="pair"');
    await writeFile(join(project.path, "index.html"), linked);
    await expect(
      service.cutWords(project, transcript.id, {
        wordIds: ["three"],
        action: "cut",
      }),
    ).rejects.toThrow("linked media");
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      linked,
    );
    const animated = source.replace(
      "</body>",
      '<script>gsap.to("#footage", {x: 10});</script></body>',
    );
    await writeFile(join(project.path, "index.html"), animated);
    await expect(
      service.cutWords(project, transcript.id, {
        wordIds: ["three"],
        action: "cut",
      }),
    ).rejects.toThrow("scripted animation");
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      animated,
    );
  } finally {
    await service.dispose();
    await fixture.close();
  }
});

test("word seeking follows outside trims and playback-rate changes without changing cut ownership", async () => {
  const fixture = await projectFixture();
  const service = createTranscriptService(fixture.store);
  try {
    const project = await fixture.store.create({
      name: "Current media mapping",
    });
    await writeFile(join(project.path, "index.html"), source);
    await writeFile(join(project.path, "footage.mp4"), "unchanged source");
    const transcript = await service.importTranscript(project, {
      sourceFile: "index.html",
      mediaPath: "footage.mp4",
      elementId: "footage",
      language: "en",
      words,
    });
    const trimmed = source
      .replace(
        'data-start="0" data-duration="10"',
        'data-start="5" data-duration="3" data-playback-rate="2"',
      )
      .replace('data-media-start="2"', 'data-media-start="4"');
    await writeFile(join(project.path, "index.html"), trimmed);
    const current = (await service.list(project))[0]!;
    expect(current.words.map((word) => word.timelineStart)).toEqual([
      null,
      null,
      5,
      5.5,
      6,
    ]);
    expect(current.duration).toBe(3);
    expect(current.words.every((word) => !word.cut)).toBe(true);
    const noOp = await service.cutWords(project, transcript.id, {
      wordIds: ["one"],
      action: "restore",
    });
    expect(noOp.words.map((word) => word.timelineStart)).toEqual([
      null,
      null,
      5,
      5.5,
      6,
    ]);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      trimmed,
    );
  } finally {
    await service.dispose();
    await fixture.close();
  }
});

test("transcript imports use canonical source and media identity instead of path or index aliases", async () => {
  const fixture = await projectFixture();
  const service = createTranscriptService(fixture.store);
  try {
    const project = await fixture.store.create({ name: "Transcript identity" });
    await writeFile(join(project.path, "index.html"), source);
    await writeFile(join(project.path, "footage.mp4"), "unchanged source");
    const first = await service.importTranscript(project, {
      sourceFile: "./index.html",
      mediaPath: "./footage.mp4",
      elementId: "media:0",
      language: "en",
      words,
    });
    expect(first.sourceFile).toBe("index.html");
    expect(first.mediaPath).toBe("footage.mp4");
    expect(first.elementId).toBe("footage");
    await expect(
      service.importTranscript(project, {
        sourceFile: "index.html",
        mediaPath: "footage.mp4",
        elementId: "footage",
        language: "en",
        words,
      }),
    ).rejects.toThrow("already has a transcript");
    await symlink("index.html", join(project.path, "alias.html"));
    await expect(
      service.importTranscript(project, {
        sourceFile: "alias.html",
        mediaPath: "footage.mp4",
        elementId: "footage",
        language: "en",
        words,
      }),
    ).rejects.toThrow("already has a transcript");
    await service.cutWords(project, first.id, {
      wordIds: ["three"],
      action: "cut",
    });
    const current = parseSourceDocument(
      await readFile(join(project.path, "index.html"), "utf8"),
    ).document;
    const splitId = current.querySelectorAll("[data-cutroom-transcript]")[1]!
      .id;
    await expect(
      service.importTranscript(project, {
        sourceFile: "index.html",
        mediaPath: "footage.mp4",
        elementId: splitId,
        language: "en",
        words,
      }),
    ).rejects.toThrow("already has a transcript");
    expect((await fixture.store.document(project)).transcripts).toHaveLength(1);
  } finally {
    await service.dispose();
    await fixture.close();
  }
});

test("anonymous media gains stable transcript identity before another clip is split", async () => {
  const fixture = await projectFixture();
  const service = createTranscriptService(fixture.store);
  try {
    const project = await fixture.store.create({ name: "Anonymous clips" });
    const html =
      '<html><body><main data-composition-id="main" data-duration="12"><audio src="speech.wav" class="clip" data-start="0" data-duration="4"></audio><audio src="speech.wav" class="clip" data-start="8" data-duration="4"></audio></main></body></html>';
    await writeFile(join(project.path, "index.html"), html);
    await writeFile(join(project.path, "speech.wav"), "unchanged source");
    const first = await service.importTranscript(project, {
      sourceFile: "index.html",
      mediaPath: "speech.wav",
      elementId: "media:0",
      language: "en",
      words: [{ id: "a", text: "A", start: 1, end: 2 }],
    });
    const second = await service.importTranscript(project, {
      sourceFile: "index.html",
      mediaPath: "speech.wav",
      elementId: "media:1",
      language: "en",
      words: [{ id: "b", text: "B", start: 0, end: 1 }],
    });
    expect(first.elementId).not.toBe("media:0");
    expect(second.elementId).not.toBe("media:1");
    await service.cutWords(project, first.id, {
      wordIds: ["a"],
      action: "cut",
    });
    expect(
      (await service.list(project)).find((item) => item.id === second.id)
        ?.words[0]?.timelineStart,
    ).toBe(7);
    await service.cutWords(project, second.id, {
      wordIds: ["b"],
      action: "cut",
    });
    const document = parseSourceDocument(
      await readFile(join(project.path, "index.html"), "utf8"),
    ).document;
    expect(
      document
        .querySelector(`[data-cutroom-transcript="${second.id}"]`)
        ?.getAttribute("data-start"),
    ).toBe("7");
    expect(
      document
        .querySelector(`[data-cutroom-transcript="${second.id}"]`)
        ?.getAttribute("data-duration"),
    ).toBe("3");
    expect(await readFile(join(project.path, "speech.wav"), "utf8")).toBe(
      "unchanged source",
    );
  } finally {
    await service.dispose();
    await fixture.close();
  }
});

test("the footage picker retains leading-cut and fully cut media so its script can be restored", async () => {
  const fixture = await projectFixture();
  const service = createTranscriptService(fixture.store);
  try {
    const project = await fixture.store.create({ name: "Restore all words" });
    const html =
      '<html><body><main data-composition-id="main" data-duration="4"><audio id="speech" class="clip" src="speech.wav" data-start="0" data-duration="4"></audio></main></body></html>';
    await writeFile(join(project.path, "index.html"), html);
    await writeFile(join(project.path, "speech.wav"), "unchanged source");
    const transcript = await service.importTranscript(project, {
      sourceFile: "index.html",
      mediaPath: "speech.wav",
      elementId: "speech",
      language: "en",
      words: [
        { id: "first", text: "First", start: 0, end: 2 },
        { id: "last", text: "last", start: 2, end: 4 },
      ],
    });
    await service.cutWords(project, transcript.id, {
      wordIds: ["first"],
      action: "cut",
    });
    expect(
      (await listMedia(project)).map((clip) => [clip.elementId, clip.duration]),
    ).toEqual([["speech", 2]]);
    await service.cutWords(project, transcript.id, {
      wordIds: ["last"],
      action: "cut",
    });
    expect(
      (await listMedia(project)).map((clip) => [clip.elementId, clip.duration]),
    ).toEqual([["speech", 0]]);
    await service.cutWords(project, transcript.id, {
      wordIds: ["first", "last"],
      action: "restore",
    });
    expect(
      (await listMedia(project)).map((clip) => [clip.elementId, clip.duration]),
    ).toEqual([["speech", 4]]);
  } finally {
    await service.dispose();
    await fixture.close();
  }
});

test("malformed media URLs do not hide valid footage or escape the import boundary", async () => {
  const fixture = await projectFixture();
  const service = createTranscriptService(fixture.store);
  try {
    const project = await fixture.store.create({ name: "Malformed media" });
    const html = source.replace(
      "</main>",
      '<video id="bad" src="bad%" data-start="0" data-duration="4"></video></main>',
    );
    await writeFile(join(project.path, "index.html"), html);
    await writeFile(join(project.path, "footage.mp4"), "unchanged source");
    expect((await listMedia(project)).map((clip) => clip.elementId)).toEqual([
      "footage",
      "following",
    ]);
    await expect(
      service.importTranscript(project, {
        sourceFile: "index.html",
        mediaPath: "footage.mp4",
        elementId: "bad",
        language: "en",
        words,
      }),
    ).rejects.toThrow("valid local project media");
    expect((await fixture.store.document(project)).transcripts).toHaveLength(0);
  } finally {
    await service.dispose();
    await fixture.close();
  }
});
