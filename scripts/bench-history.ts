import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { historyClips, historyProjectHtml } from "./bench-history-project";
import { historyCandidate } from "../src/server/projects/history";
import {
  externalHistoryCredential,
  ownerWho,
} from "../src/server/projects/historyActor";
import { createReviewService } from "../src/server/projects/review";
import { createProjectRoutes } from "../src/server/projects/routes";
import type { ProjectStore } from "../src/server/projects/store";
import { AGENT_HEADER, AGENT_NAME_HEADER } from "../src/shared/review";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  compositionMarkup,
  historyComposition,
  reverseComposition,
} from "../src/server/timeline/composition";
import { createTimelineRoutes } from "../src/server/timeline/routes";

function median(times: number[]) {
  return times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)]!;
}

export const historyBudgets = {
  historySelection: 1,
  historyPlan: 3,
  historySelective: 80,
};

export async function benchHistory(store: ProjectStore) {
  const project = await store.create({ name: "History benchmark" });
  const source = join(project.path, "index.html");
  await writeFile(source, historyProjectHtml);
  await writeFile(
    join(project.path, "talk.mp4"),
    "synthetic fixture with authored timing",
  );
  const review = createReviewService(store);
  const timeline = createTimelineRoutes(store, review);
  const app = new Hono()
    .route(
      "/",
      createProjectRoutes(
        store,
        review,
        undefined,
        undefined,
        timeline.timelineSnapshot,
      ),
    )
    .route("/", timeline);
  const path = `/projects/${project.id}`;
  const credential = externalHistoryCredential();
  const read = async () =>
    TimelineViewSchema.parse(
      await (await app.request(`${path}/timeline`)).json(),
    );
  const post = (route: string, body: unknown, agent = false) =>
    app.request(`${path}/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(agent && {
          [AGENT_HEADER]: credential,
          [AGENT_NAME_HEADER]: "Bench agent",
        }),
      },
      body: JSON.stringify(body),
    });
  const change = async (command: CommandInput, agent = false) => {
    const response = await post(
      "commands",
      { expectedRevision: (await read()).revision, commands: [command] },
      agent,
    );
    if (!response.ok) throw new Error(await response.text());
    const id = response.headers.get("x-cutroom-history-entry");
    if (!id)
      throw new Error("The benchmark edit did not create a history entry.");
    return id;
  };
  if ((await read()).timeline.clips.length !== historyClips)
    throw new Error("The history composition must have 1,038 clips.");

  const ledger = await store.history(project);
  const edit: CommandInput = {
    type: "setClip",
    clipId: "title-5",
    opacity: 0.5,
  };
  const exactEngine: number[] = [];
  const exact: number[] = [];
  const selective: number[] = [];
  const samples: string[] = [];
  const replayResponse = z.object({ view: TimelineViewSchema });
  const undo = async () => {
    const start = performance.now();
    const response = await post("history/undo", { composition: "index.html" });
    const elapsed = performance.now() - start;
    if (!response.ok) throw new Error(await response.text());
    const { view } = replayResponse.parse(await response.json());
    if (view.timeline.clips.length !== historyClips)
      throw new Error("The replay did not return the full verified timeline.");
    return elapsed;
  };
  for (let run = 0; run < 11; run++) {
    const target = await change(edit);
    const start = performance.now();
    const result = await ledger.undo(target, { who: ownerWho });
    exactEngine.push(performance.now() - start);
    if (!result.ok || !result.entry)
      throw new Error("Exact engine undo failed.");

    await change(edit);
    exact.push(await undo());

    if (run === 0) samples.push(await readFile(source, "utf8"));
    await change(edit);
    if (run === 0) samples.push(await readFile(source, "utf8"));
    await change(
      { type: "setClip", clipId: "title-70", text: `Agent title ${run}` },
      true,
    );
    if (run === 0) samples.push(await readFile(source, "utf8"));
    selective.push(await undo());
  }

  const projections = samples.map((html) =>
    historyComposition(compositionMarkup(html)),
  );
  if (projections.length !== 3 || projections.some((projection) => !projection))
    throw new Error("The benchmark snapshots must have named clips.");
  const oldest = ledger.list().find((entry) => entry.who.kind === "agent")!;
  const newest = ledger
    .list()
    .find((entry) => entry.who.kind === "person" && !entry.undoes)!;
  const entries = [
    { ...newest, undone: false },
    ...Array.from({ length: 499 }, (_, index) => ({
      ...oldest,
      id: `other-${index}`,
    })),
  ];
  const plan: number[] = [];
  const selection: number[] = [];
  for (let run = 0; run < 31; run++) {
    let start = performance.now();
    if (historyCandidate(entries, "undo", ownerWho)?.id !== newest.id)
      throw new Error("The owner edit was missed.");
    selection.push(performance.now() - start);
    start = performance.now();
    const inverse = reverseComposition(
      projections[0]!,
      projections[1]!,
      projections[2]!,
      () => false,
    );
    if (!inverse) throw new Error("The independent clip edit should reverse.");
    plan.push(performance.now() - start);
  }
  const groups = { group1: 0, group5: 0, group10: 0 };
  await change({ type: "remove", clipIds: ["talk-3"], ripple: true });
  for (let index = 1; index <= 10; index++) {
    const clipId = `title-${index + 20}`;
    const clip = (await read()).timeline.clips.find(({ id }) => id === clipId)!;
    await change(
      { type: "trim", clipId, edge: "end", to: clip.start + 90 },
      true,
    );
    if (index !== 1 && index !== 5 && index !== 10) continue;
    const started = performance.now();
    const response = await post("history/undo", { composition: "index.html" });
    groups[`group${index}`] = performance.now() - started;
    if (response.status !== 409)
      throw new Error("The dependent trim should block undo.");
  }
  return {
    historySelection: median(selection),
    historyExactEngine: median(exactEngine),
    historyExact: median(exact),
    historyPlan: median(plan),
    historySelective: median(selective),
    ...groups,
  };
}
