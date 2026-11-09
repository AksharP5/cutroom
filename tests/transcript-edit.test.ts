import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSourceDocument } from "@hyperframes/studio-server";
import { ProjectDocumentSchema, TranscriptSchema } from "../src/shared/project";
import { createTranscriptService } from "../src/server/transcript/service";
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
