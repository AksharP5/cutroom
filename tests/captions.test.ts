import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSourceDocument } from "@hyperframes/studio-server";
import { CaptionsViewSchema } from "../src/shared/captions";
import { TranscriptSchema } from "../src/shared/project";
import { groupWords } from "../src/server/captions/captions";
import { createCaptionRoutes } from "../src/server/captions/routes";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { createTranscriptService } from "../src/server/transcript/service";
import { projectFixture } from "./project-fixture";

const source = `<!doctype html><html><head></head><body><main data-composition-id="main" data-width="1920" data-height="1080" data-duration="12"><video id="talk" class="clip" src="talk.mp4" data-start="0" data-duration="12" data-track-index="0"></video></main></body></html>`;
const words = [
  { id: "w1", text: "Make", start: 1, end: 1.4 },
  { id: "w2", text: "room", start: 1.5, end: 2 },
  { id: "w3", text: "now.", start: 2.1, end: 2.6 },
  { id: "w4", text: "Cut", start: 4, end: 4.5 },
  { id: "w5", text: "this", start: 4.6, end: 5 },
  { id: "w6", text: "Keep", start: 7, end: 7.4 },
  { id: "w7", text: "going", start: 7.5, end: 8 },
];

async function captionsFixture() {
  const fixture = await projectFixture();
  const timeline = createTimelineRoutes(fixture.store, fixture.review);
  fixture.app.route("/api/cutroom", timeline);
  fixture.app.route(
    "/api/cutroom",
    createCaptionRoutes(
      fixture.store,
      fixture.review,
      createTranscriptService(fixture.store),
      timeline.editInWindow,
    ),
  );
  const project = await fixture.store.create({ name: "Captions" });
  await writeFile(join(project.path, "index.html"), source);
  await writeFile(join(project.path, "talk.mp4"), "not decoded in this test");
  const json = async (path: string, method = "GET", body?: unknown) => {
    const response = await fixture.request(
      `/projects/${project.id}${path}`,
      method,
      body,
    );
    const text = await response.text();
    expect(response.ok, text).toBe(true);
    return JSON.parse(text) as unknown;
  };
  return { fixture, project, json };
}

const lines = (html: string) => {
  const template =
    parseSourceDocument(html).document.querySelector("template")!;
  const { document } = parseSourceDocument(template.innerHTML);
  return [...document.querySelectorAll(".caption-group")].map((group) => ({
    start: Number(group.getAttribute("data-start")),
    text: group.textContent,
  }));
};

test("captions follow script cuts in the same undo step, and keep a corrected word", async () => {
  const { fixture, project, json } = await captionsFixture();
  try {
    const transcript = TranscriptSchema.parse(
      await json("/transcripts/import", "POST", {
        mediaPath: "talk.mp4",
        elementId: "talk",
        words,
      }),
    );
    const added = CaptionsViewSchema.parse(
      await json("/captions", "POST", {
        action: "generate",
        transcriptId: transcript.id,
      }),
    );
    expect(added).toMatchObject({
      file: "compositions/captions.html",
      style: "karaoke",
      stale: false,
    });
    // A sentence end and each pause start a line; lines hold after their last word.
    expect(added.cues).toEqual([
      { start: 1, end: 3.2, text: "Make room now." },
      { start: 4, end: 5.6, text: "Cut this" },
      { start: 7, end: 8.6, text: "Keep going" },
    ]);
    const index = parseSourceDocument(
      await readFile(join(project.path, "index.html"), "utf8"),
    ).document;
    const host = index.querySelector(`#${added.clipId}`)!;
    expect(host.getAttribute("data-track-kind")).toBe("captions");
    expect(host.getAttribute("data-track-index")).toBe("1");
    expect(host.getAttribute("data-composition-src")).toBe(
      "compositions/captions.html",
    );
    expect(host.getAttribute("data-start")).toBe("1");

    await json("/captions", "POST", {
      action: "word",
      transcriptId: transcript.id,
      wordId: "w6",
      text: "Keeps",
    });
    // Cutting "Cut this" ripples the footage 1 s earlier after 4 s; the captions follow.
    await json(`/transcripts/${transcript.id}/cuts`, "POST", {
      wordIds: ["w4", "w5"],
      action: "cut",
    });
    const cut = CaptionsViewSchema.parse(
      ((await json("/captions")) as { captions: unknown[] }).captions[0],
    );
    expect(cut.stale).toBe(false);
    expect(cut.edits).toEqual({ w6: "Keeps" });
    expect(cut.cues.map((cue) => [cue.start, cue.text])).toEqual([
      [1, "Make room now."],
      [6, "Keeps going"],
    ]);
    // One undo takes back the cut and the captions that followed it.
    expect(
      (await fixture.request(`/projects/${project.id}/history/undo`, "POST"))
        .status,
    ).toBe(200);
    expect(
      lines(
        await readFile(
          join(project.path, "compositions/captions.html"),
          "utf8",
        ),
      ).map((line) => line.text),
    ).toEqual(["Make room now.", "Cut this", "Keeps going"]);
    // Undoing the correction and then the captions leaves the project as it was.
    for (const _ of [1, 2])
      expect(
        (await fixture.request(`/projects/${project.id}/history/undo`, "POST"))
          .status,
      ).toBe(200);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      source,
    );
    expect(
      await Bun.file(join(project.path, "compositions/captions.html")).exists(),
    ).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("transcript text is written as text, never as markup", async () => {
  const { fixture, project, json } = await captionsFixture();
  try {
    const hostile =
      '</span><script>alert("x")</script><img src=x onerror=alert(1)>';
    const transcript = TranscriptSchema.parse(
      await json("/transcripts/import", "POST", {
        mediaPath: "talk.mp4",
        elementId: "talk",
        words: [{ id: 'a"b<c>', text: hostile, start: 1, end: 2 }],
      }),
    );
    const view = CaptionsViewSchema.parse(
      await json("/captions", "POST", {
        action: "generate",
        transcriptId: transcript.id,
      }),
    );
    const html = await readFile(join(project.path, view.file), "utf8");
    const template =
      parseSourceDocument(html).document.querySelector("template")!;
    const { document } = parseSourceDocument(template.innerHTML);
    expect(document.querySelectorAll("script, img")).toHaveLength(0);
    expect(document.querySelector(".caption-word")?.textContent).toBe(hostile);
    expect(
      document.querySelector(".caption-word")?.getAttribute("data-word-id"),
    ).toBe('a"b<c>');
    expect(view.cues[0]?.text).toBe(hostile);
  } finally {
    await fixture.close();
  }
});

test("lines break at sentences and pauses, into the fewest even lines, at a clause end when it costs little balance", () => {
  let at = 0;
  const spoken = (text: string, pause = 0) =>
    text.split(" ").map((word, index) => {
      at += index === 0 ? pause : 0.05;
      const start = at;
      at += 0.25;
      return { id: `${start}`, text: word, start, end: at };
    });
  const words = [
    ...spoken("And so my fellow Americans,"),
    ...spoken("ask not", 0.3),
    ...spoken("what your country can do for you,", 1),
    ...spoken("ask what you can do for your country."),
    ...spoken("Thank you."),
  ];
  const lines = (frame: { width: number; height: number }) =>
    groupWords(words, frame).map((line) =>
      line.words.map((word) => word.text).join(" "),
    );
  expect(lines({ width: 1920, height: 1080 })).toEqual([
    "And so my fellow Americans, ask not",
    "what your country can do for you,",
    "ask what you can do for your country.",
    "Thank you.",
  ]);
  // A vertical frame holds fewer characters a line; a long phrase splits into even lines.
  expect(lines({ width: 1080, height: 1920 })).toEqual([
    "And so my fellow",
    "Americans, ask not",
    "what your country can do",
    "for you, ask what you",
    "can do for your country.",
    "Thank you.",
  ]);
  // A clause end is the better break when it costs little balance.
  at = 0;
  const clause = spoken(
    "what your country you, ask what you can do for your country.",
  );
  expect(
    groupWords(clause, { width: 1920, height: 1080 }).map((line) =>
      line.words.map((word) => word.text).join(" "),
    ),
  ).toEqual([
    "what your country you,",
    "ask what you can do for your country.",
  ]);
});

test("imported subtitles keep their cues as caption lines, timed as written, in and out of Cutroom", async () => {
  const { fixture, project, json } = await captionsFixture();
  try {
    const srt =
      "1\n00:00:00,200 --> 00:00:03,000\n<i>And so,</i> my fellow Americans:\n\n" +
      "2\n00:00:03,300 --> 00:00:04,400\nask not\n";
    const transcript = TranscriptSchema.parse(
      await json("/transcripts/subtitles", "POST", {
        mediaPath: "talk.mp4",
        elementId: "talk",
        format: "srt",
        text: srt,
      }),
    );
    await json("/captions", "POST", {
      action: "generate",
      transcriptId: transcript.id,
    });
    expect(await json(`/captions/${transcript.id}/export?format=vtt`)).toEqual({
      format: "vtt",
      filename: "talk.vtt",
      text: "WEBVTT\n\n00:00:00.200 --> 00:00:03.000\nAnd so, my fellow Americans:\n\n00:00:03.300 --> 00:00:04.400\nask not\n",
    });
    const refused = await fixture.request(
      `/projects/${project.id}/transcripts/subtitles`,
      "POST",
      {
        mediaPath: "talk.mp4",
        elementId: "talk",
        format: "vtt",
        text: "00:00.000 --> 00:01.000\nNo header\n",
      },
    );
    expect(refused.status).toBe(400);
  } finally {
    await fixture.close();
  }
});
