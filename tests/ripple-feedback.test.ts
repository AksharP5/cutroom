import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { parseComposition } from "../src/server/timeline/composition";
import { readSource } from "../src/server/projects/store";
import { projectFixture } from "./project-fixture";
import { applyAll } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput, TimelineView } from "../src/shared/timeline/schema";
import {
  outsideChanges,
  outsideMessage,
  overwriteFeedback,
  rippleFeedback,
} from "../src/client/edit/feedback";

const parsed = (body: string) =>
  parseComposition(
    `<main data-composition-id="main" data-duration="40" data-fps="30">${body}</main>`,
    emptyTimelineSettings(),
  ).timeline;
const shot =
  '<div id="shot" data-start="0" data-duration="30" data-track-index="0">A title</div>';
const title =
  '<div id="title" data-start="2" data-duration="2" data-track-index="1">Another title</div>';
const follower =
  '<div id="next" data-start="30" data-duration="10" data-track-index="0">Next</div>';
const report = (body: string, input: CommandInput[]) => {
  const before = parsed(body);
  const commands = input.map((command) => CommandSchema.parse(command));
  return rippleFeedback(
    before,
    applyAll(before, commands),
    commands,
    new Map(),
  );
};

test("ripple reports use the edit interval even when an unrelated longer track determines duration", () => {
  expect(
    report(shot + title + follower, [
      { type: "trim", clipId: "shot", edge: "start", to: 827, ripple: true },
    ]),
  ).toBe("Removed 27:17 from 2 tracks. 1 clip deleted.");
  expect(
    report(shot + follower, [
      { type: "trim", clipId: "shot", edge: "start", to: 30, ripple: true },
    ]),
  ).toBe("");
  expect(
    report(shot + title, [
      { type: "trim", clipId: "shot", edge: "end", to: 30, ripple: true },
    ]),
  ).toBe("Removed 29:00 from 2 tracks. 1 clip deleted.");
});

test("ripple delete reports deletions, while lift stays silent", () => {
  expect(
    report(shot + follower, [
      { type: "remove", clipIds: ["shot"], ripple: true },
    ]),
  ).toBe("Removed 30:00 from 1 track. 1 clip deleted.");
  expect(
    report(shot + follower, [
      { type: "remove", clipIds: ["shot"], ripple: false },
    ]),
  ).toBe("");
  // Script targets can be removed even when the source cannot safely be copied.
  expect(
    report(
      shot + follower + '<script>gsap.to("#shot", {opacity:0});</script>',
      [{ type: "remove", clipIds: ["shot"], ripple: true }],
    ),
  ).toBe("Removed 30:00 from 1 track. 1 clip deleted.");
});

test("ripple drops and Paste Insert report time opened on other tracks", () => {
  const before = parsed(shot + title);
  const clipboard = new Map([["copy", [before.clips[0]!]]]);
  for (const input of [
    {
      type: "insert",
      track: 0,
      at: 0,
      mode: "insert",
      clip: { kind: "image", src: "still.png", duration: 60 },
    },
    { type: "paste", clipboardId: "copy", at: 0, mode: "insert" },
  ] satisfies CommandInput[]) {
    const command = CommandSchema.parse(input);
    const after = applyAll(before, [command], { clipboards: clipboard });
    expect(rippleFeedback(before, after, [command], clipboard)).toBe(
      `Inserted ${input.type === "paste" ? "30" : "02"}:00 on 2 tracks.`,
    );
  }
});

test("ripple drops include a newly created destination track in the affected count", () => {
  const before = parsed(shot + title);
  const commands = [
    { type: "setTrack", index: 2, kind: "video" },
    {
      type: "insert",
      track: 2,
      at: 0,
      mode: "insert",
      clip: { kind: "image", src: "still.png", duration: 60 },
    },
  ].map((command) => CommandSchema.parse(command));
  const after = applyAll(before, commands);
  expect(rippleFeedback(before, after, commands, new Map())).toBe(
    "Inserted 02:00 on 3 tracks.",
  );
});

test("outside edits ignore attribution-only refreshes and distinguish moves, title updates and removal", () => {
  const timeline = parsed(shot + title);
  const before: TimelineView = {
    composition: "index.html",
    revision: "before",
    timeline,
  };
  const after: TimelineView = {
    ...before,
    revision: "after",
    timeline: {
      ...timeline,
      clips: timeline.clips.map((clip) => ({
        ...clip,
        start: clip.start + 30,
      })),
    },
    clipEdits: [
      {
        id: "agent-edit",
        clipId: "shot",
        composition: "index.html",
        label: "Moved",
        at: "now",
        by: "agent",
        accepted: false,
      },
      {
        id: "agent-title-edit",
        clipId: "title",
        composition: "index.html",
        label: "Moved",
        at: "now",
        by: "agent",
        accepted: false,
      },
    ],
  };
  const change = outsideChanges(before, after);
  expect(outsideMessage(change.changes, new Set([change.actor]))).toBe(
    "Agent moved 2 clips.",
  );
  expect(outsideChanges(before, { ...after, timeline }).timelineChanged).toBe(
    false,
  );
  const updated = {
    ...before,
    timeline: {
      ...timeline,
      clips: [{ ...timeline.clips[0]!, text: "New text" }],
    },
  };
  expect([...outsideChanges(before, updated).changes]).toEqual([
    ["shot", "updated"],
    ["title", "deleted"],
  ]);
});

test("the existing HTML parse supplies decoded first-line title text without scripts or inert templates", () => {
  const [clip] = parsed(
    '<div id="title" data-start="0" data-duration="3"><script>wrong()</script><style>.bad{}</style><template>not live</template><b>Hello &amp; welcome</b><br>Second line</div>',
  ).clips;
  expect(clip?.textPreview).toBe("Hello & welcome");
  expect(clip?.text).toBe("Hello & welcome\nSecond line");
});

test("owner history rows stay silent while unrelated agent and disk edits are reported", () => {
  const before: TimelineView = {
    composition: "index.html",
    revision: "before",
    timeline: parsed(shot + title),
  };
  const owner = {
    id: "owner-edit",
    clipId: "shot",
    composition: "index.html",
    label: "Edited title",
    at: "now",
    by: "human" as const,
    accepted: true,
  };
  const after: TimelineView = {
    ...before,
    revision: "after",
    timeline: parsed(shot.replace("A title", "Owner title") + title),
    clipEdits: [owner],
  };
  expect(outsideChanges(before, after).timelineChanged).toBe(false);
  const mixed: TimelineView = {
    ...after,
    timeline: parsed(
      shot.replace("A title", "Owner title") +
        title.replace('data-start="2"', 'data-start="3"'),
    ),
    clipEdits: [
      owner,
      {
        ...owner,
        id: "agent-edit",
        clipId: "title",
        by: "agent",
        accepted: false,
      },
    ],
  };
  const agent = outsideChanges(before, mixed);
  expect([...agent.changes]).toEqual([["title", "moved"]]);
  expect(agent.actor).toBe("Agent");
  const disk = outsideChanges(before, { ...mixed, clipEdits: [owner] });
  expect([...disk.changes]).toEqual([["title", "moved"]]);
  expect(disk.actor).toBe("Outside edit");
});

test("composition reads wait for an admitted edit and return its source with its attribution", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({
    name: "Consistent attribution",
  });
  const original = await readSource(project, "index.html");
  const changed = original.content.replaceAll(
    "Consistent attribution",
    "Owner title",
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writing = fixture.review.editComposition(
    project,
    "index.html",
    undefined,
    () =>
      fixture.store.mutate(project, "Owner source save", async () => {
        entered.resolve();
        await release.promise;
        await writeFile(`${project.path}/index.html`, changed);
      }),
  );
  try {
    await entered.promise;
    const reading = fixture.review.readComposition(
      project,
      "index.html",
      async () => ({
        source: await readSource(project, "index.html"),
      }),
    );
    release.resolve();
    const view = await reading;
    expect(view.source.content).toBe(changed);
    expect(view.clipEdits).toContainEqual(
      expect.objectContaining({
        clipId: "headline",
        by: "human",
        label: "Owner source save",
      }),
    );
  } finally {
    release.resolve();
    await writing;
    await fixture.close();
  }
});

test("overwrite feedback names whole replacements once, while partial cuts and insert stay silent", () => {
  const before = parsed(shot + follower);
  const report = (input: CommandInput) => {
    const command = CommandSchema.parse(input);
    return overwriteFeedback(before, applyAll(before, [command]), [command]);
  };
  expect(
    report({
      type: "insert",
      track: 0,
      at: 0,
      mode: "overwrite",
      clip: { kind: "image", src: "still.png", duration: 900 },
    }),
  ).toBe("Replaced shot.");
  for (const [at, duration] of [
    [0, 30],
    [30, 30],
    [870, 30],
  ] as const)
    expect(
      report({
        type: "insert",
        track: 0,
        at,
        mode: "overwrite",
        clip: { kind: "image", src: "still.png", duration },
      }),
    ).toBe("");
  expect(
    report({
      type: "insert",
      track: 0,
      at: 0,
      mode: "insert",
      clip: { kind: "image", src: "still.png", duration: 900 },
    }),
  ).toBe("");
  expect(report({ type: "remove", clipIds: ["shot"] })).toBe("");
  expect(report({ type: "move", clipIds: ["next"], by: -900 })).toBe("");
  // The later title is entirely covered when the picture moves onto its track.
  const stacked = parsed(shot + title);
  const command = CommandSchema.parse({
    type: "move",
    clipIds: ["shot"],
    trackBy: 1,
  });
  expect(
    overwriteFeedback(stacked, applyAll(stacked, [command]), [command]),
  ).toBe("Replaced title.");
});

test("outside notices retain the caller name", () => {
  const before: TimelineView = {
    composition: "index.html",
    revision: "one",
    timeline: parsed(shot),
  };
  const after: TimelineView = {
    ...before,
    revision: "two",
    timeline: {
      ...before.timeline,
      clips: before.timeline.clips.map((clip) => ({ ...clip, start: 30 })),
    },
    clipEdits: [
      {
        id: "new",
        clipId: "shot",
        composition: "index.html",
        label: "Moved",
        by: "agent",
        agentName: "Checkpoint",
        at: "now",
        accepted: false,
      },
    ],
  };
  const change = outsideChanges(before, after);
  expect(outsideMessage(change.changes, new Set([change.actor]))).toBe(
    "Checkpoint moved 1 clip.",
  );
});
