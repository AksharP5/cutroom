import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectStore } from "../src/server/projects/store";
import { createTranscriptService } from "../src/server/transcript/service";

const directory = await mkdtemp(join(tmpdir(), "cutroom-transcript-bench-"));
const store = await createProjectStore({ dataDir: directory });
const service = createTranscriptService(store);
const workloads = [
  { clips: 1, wordsPerClip: 10_000 },
  { clips: 100, wordsPerClip: 50 },
];
const results = [];
try {
  for (const workload of workloads) {
    const project = await store.create({ name: "Transcript benchmark" });
    const clips = Array.from(
      { length: workload.clips },
      (_, index) =>
        `<audio id="clip-${index}" class="clip" src="source.wav" data-start="${index}" data-duration="1" data-track-index="0"></audio>`,
    );
    await writeFile(
      join(project.path, "index.html"),
      `<html><body><main data-composition-id="main" data-width="1920" data-height="1080" data-duration="${workload.clips}">${clips.join("")}</main></body></html>`,
    );
    const transcripts = clips.map((html, index) => ({
      id: `transcript-${index}`,
      mediaPath: "source.wav",
      sourceFile: "index.html",
      elementId: `clip-${index}`,
      language: "en",
      words: Array.from({ length: workload.wordsPerClip }, (_, word) => ({
        id: `word-${word}`,
        text: "word",
        start: word / workload.wordsPerClip,
        end: (word + 1) / workload.wordsPerClip,
      })),
      cutWordIds: [],
      createdAt: new Date().toISOString(),
      original: {
        html,
        start: index,
        duration: 1,
        mediaStart: 0,
        playbackRate: 1,
      },
    }));
    await writeFile(
      join(project.path, "cutroom.json"),
      JSON.stringify({ schemaVersion: 1, annotations: [], transcripts }),
    );
    const times = [];
    for (let run = 0; run < 7; run++) {
      const started = performance.now();
      const views = await service.list(project);
      times.push(performance.now() - started);
      const expected =
        Math.round(
          (workload.clips -
            1 +
            (workload.wordsPerClip - 1) / workload.wordsPerClip) *
            1_000_000,
        ) / 1_000_000;
      if (
        views.length !== workload.clips ||
        views.at(-1)?.words.at(-1)?.timelineStart !== expected
      )
        throw new Error("The benchmark returned incorrect transcript timing.");
    }
    const warm = times.slice(1).sort((a, b) => a - b);
    results.push({
      ...workload,
      coldMs: times[0],
      warmMedianMs: (warm[2]! + warm[3]!) / 2,
      warmRangeMs: [warm[0], warm.at(-1)],
    });
  }
  console.log(
    JSON.stringify(
      { runtime: `Bun ${Bun.version}`, warmRuns: 6, results },
      null,
      2,
    ),
  );
} finally {
  await service.dispose();
  await store.close();
  await rm(directory, { recursive: true, force: true });
}
