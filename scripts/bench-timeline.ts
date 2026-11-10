import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { applyAll } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  TimelineViewSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { createProjectStore } from "../src/server/projects/store";
import {
  parseComposition,
  patchComposition,
} from "../src/server/timeline/composition";
import { createReviewService } from "../src/server/projects/review";
import { createTimelineRoutes } from "../src/server/timeline/routes";

/**
 * Median milliseconds a step may take: the 500-clip edit, ripple-deleting 120 separate ranges,
 * and lifting 1,000 of 2,000 clips in one
 * batch (select all, delete), where every removal checks that the clip owns its bytes.
 */
const budgets = {
  parse: 10,
  apply: 5,
  multiRangeApply: 15,
  patch: 5,
  request: 50,
  bulkApply: 20,
  bulkPatch: 20,
};
const runs = 31;

// A transcript-cut talking head: 240 linked picture and sound pieces plus 20 titles.
const pieces = Array.from({ length: 240 }, (_, index) => {
  const start = index * 2.5;
  const timing = `data-start="${start}" data-duration="2.5" data-media-start="${index * 3}"`;
  return `  <video id="talk-${index}" src="talk.mp4" muted data-link="lk-${index}" ${timing} data-track-index="0"></video>
  <audio id="voice-${index}" src="talk.mp4" data-link="lk-${index}" ${timing} data-track-index="1"></audio>`;
});
const titles = Array.from(
  { length: 20 },
  (_, index) =>
    `  <div id="title-${index}" class="clip title" data-start="${index * 30 + 20}" data-duration="4" data-track-index="2"><h1>Chapter ${index + 1}</h1></div>`,
);
const html = `<!doctype html>
<html><head><style>.title{position:absolute;inset:0}</style></head>
<body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="600" data-fps="30">
${[...pieces, ...titles].join("\n")}
</main></body></html>
`;
const edits: CommandInput[] = [
  { type: "remove", clipIds: ["talk-3"], ripple: true },
  { type: "split", at: 9_010 },
  { type: "trim", clipId: "talk-10", edge: "end", to: 790, ripple: true },
];
const commands = edits.map((command) => CommandSchema.parse(command));
const multiRangeCommands = [
  CommandSchema.parse({
    type: "remove",
    clipIds: Array.from({ length: 120 }, (_, index) => `talk-${index * 2}`),
    ripple: true,
  }),
];

const median = (step: () => void) => {
  const times = Array.from({ length: runs }, () => {
    const started = performance.now();
    step();
    return performance.now() - started;
  }).sort((a, b) => a - b);
  return times[Math.floor(runs / 2)]!;
};

const parsed = parseComposition(html, emptyTimelineSettings());
if (parsed.timeline.clips.length !== 500)
  throw new Error("The benchmark composition must have 500 clips.");
const origins = new Map<string, ClipOrigin>();
const edited = applyAll(parsed.timeline, commands, {
  onCreate: (id, origin) => origins.set(id, origin),
});
const bulkHtml = `<main id="main" data-composition-id="main" data-duration="2000" data-fps="30">
${Array.from(
  { length: 2_000 },
  (_, index) =>
    `  <div id="card-${index}" class="clip" data-start="${Math.floor(index / 2)}" data-duration="1" data-track-index="${index % 2}"><p>Card ${index}</p></div>`,
).join("\n")}
</main>
`;
const bulk = parseComposition(bulkHtml, emptyTimelineSettings());
const bulkCommands = [
  CommandSchema.parse({
    type: "remove",
    clipIds: Array.from({ length: 1_000 }, (_, index) => `card-${index}`),
  }),
];
const bulkEdited = applyAll(bulk.timeline, bulkCommands);
const results = {
  parse: median(() => parseComposition(html, emptyTimelineSettings())),
  apply: median(() => applyAll(parsed.timeline, commands)),
  multiRangeApply: median(() => applyAll(parsed.timeline, multiRangeCommands)),
  patch: median(() => patchComposition(parsed, edited, origins)),
  request: 0,
  bulkApply: median(() => applyAll(bulk.timeline, bulkCommands)),
  bulkPatch: median(() => patchComposition(bulk, bulkEdited, new Map())),
};

const directory = await mkdtemp(join(tmpdir(), "cutroom-timeline-bench-"));
const store = await createProjectStore({ dataDir: directory });
try {
  const project = await store.create({ name: "Timeline benchmark" });
  await writeFile(join(project.path, "index.html"), html);
  const review = createReviewService(store);
  const app = new Hono().route("/", createTimelineRoutes(store, review));
  const read = async () =>
    TimelineViewSchema.parse(
      await (await app.request(`/projects/${project.id}/timeline`)).json(),
    );
  let revision = (await read()).revision;
  const times: number[] = [];
  for (let run = 0; run < 11; run++) {
    const started = performance.now();
    const response = await app.request(`/projects/${project.id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: revision,
        commands: [{ type: "remove", clipIds: [`talk-${run}`], ripple: true }],
      }),
    });
    times.push(performance.now() - started);
    if (!response.ok) throw new Error(await response.text());
    revision = TimelineViewSchema.parse(await response.json()).revision;
  }
  results.request = times.sort((a, b) => a - b)[5]!;
} finally {
  await store.close();
  await rm(directory, { recursive: true, force: true });
}

const over = Object.entries(budgets).filter(
  ([step, budget]) => results[step as keyof typeof results] > budget,
);
console.log(
  JSON.stringify(
    {
      runtime: `Bun ${Bun.version}`,
      clips: 500,
      bytes: html.length,
      medianMs: Object.fromEntries(
        Object.entries(results).map(([step, ms]) => [
          step,
          Number(ms.toFixed(2)),
        ]),
      ),
      budgetMs: budgets,
    },
    null,
    2,
  ),
);
if (over.length) {
  console.error(`Over budget: ${over.map(([step]) => step).join(", ")}`);
  process.exit(1);
}
