import { expect, test } from "bun:test";
import { parseComposition } from "../src/server/timeline/composition";
import { applyAll } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput, TimelineView } from "../src/shared/timeline/schema";
import {
  outsideChanges,
  outsideMessage,
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
  expect(clip?.text).toBe("Hello & welcome");
});
