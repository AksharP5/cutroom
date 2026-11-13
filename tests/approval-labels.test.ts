import { expect, test } from "bun:test";
import { parseComposition } from "../src/server/timeline/composition";
import { editLabel } from "../src/shared/timeline/labels";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";

const timeline = parseComposition(
  `<main data-composition-id="main" data-duration="48" data-fps="24"><div id="cta-id" class="clip" data-label="Call to action" data-start="30" data-duration="2" data-track-index="0">Try it</div><div id="lower-id" class="clip" data-label="Lower third" data-start="1" data-duration="10" data-track-index="1">Grace Hopper</div></main>`,
  emptyTimelineSettings(),
).timeline;

test("pending command sentences name their targets and use the composition's frame rate", () => {
  for (const [input, expected] of [
    [
      { type: "move", clipIds: ["cta-id"], by: -144 },
      "Move Call to action to 00:00:24:00",
    ],
    [
      { type: "trim", clipId: "lower-id", edge: "end", to: 216 },
      "Trim end of Lower third to 00:00:09:00",
    ],
    [
      { type: "setClip", clipId: "lower-id", fadeIn: 6 },
      "Set fade in to 00:00:00:06 for Lower third",
    ],
    [
      { type: "setClip", clipId: "lower-id", opacity: 0.5 },
      "Set opacity to 50% for Lower third",
    ],
    [
      { type: "setMarker", id: "hook", name: "Hook", frame: 72 },
      'Add marker "Hook" at 00:00:03:00',
    ],
    [
      { type: "remove", clipIds: ["cta-id"], ripple: true },
      "Ripple delete Call to action",
    ],
    [
      { type: "setTiming", clipId: "cta-id", mediaStart: 1.25 },
      "Set source in to 00:00:01:06 for Call to action",
    ],
  ] satisfies [CommandInput, string][]) {
    expect(
      editLabel([CommandSchema.parse(input)], timeline, "Edit", "pending"),
    ).toBe(expected);
  }
  expect(
    editLabel(
      [
        CommandSchema.parse({
          type: "paste",
          clipboardId: "copy",
          at: 72,
          mode: "overwrite",
        }),
      ],
      timeline,
      "Edit",
      "pending",
    ),
  ).toBe("Paste clips with overwrite at 00:00:03:00");
});

test("a pending command without its composition shows exact frames rather than guessing a frame rate", () => {
  expect(
    editLabel(
      [
        CommandSchema.parse({
          type: "setMarker",
          id: "hook",
          name: "Hook",
          frame: 72,
        }),
      ],
      undefined,
      "Edit",
      "pending",
    ),
  ).toBe('Set marker: name to "Hook"; position to frame 72');
  expect(
    editLabel(
      [CommandSchema.parse({ type: "move", clipIds: ["opaque-id"], by: -24 })],
      undefined,
      "Edit",
      "pending",
    ),
  ).toBe("Move a clip 24 frames left");
});

test("overwrite approvals distinguish destination tracks and the covered interval", () => {
  for (const [track, duration, audioTrack, expected] of [
    [
      0,
      24,
      4,
      "Overwrite V1 and track 4 from 00:00:06:00 to 00:00:07:00 with interview.mp4",
    ],
    [
      1,
      240,
      5,
      "Overwrite V2 and track 5 from 00:00:06:00 to 00:00:16:00 with interview.mp4",
    ],
  ] as const) {
    expect(
      editLabel(
        [
          CommandSchema.parse({
            type: "insert",
            at: 144,
            track,
            mode: "overwrite",
            clip: { kind: "video", src: "interview.mp4", duration },
            linkedAudio: { track: audioTrack },
          }),
        ],
        timeline,
        "Edit",
        "pending",
      ),
    ).toBe(expected);
  }
});

test("marker approvals name every changed field", () => {
  const before = {
    ...timeline,
    markers: [
      {
        id: "hook",
        frame: 72,
        duration: 0,
        name: "Hook",
        note: "old",
        color: "blue" as const,
      },
    ],
  };
  expect(
    editLabel(
      [
        CommandSchema.parse({
          type: "setMarker",
          id: "hook",
          name: "Opening",
          frame: 96,
          note: "Brand safety warning",
          duration: 48,
          color: "red",
        }),
      ],
      before,
      "Edit",
      "pending",
    ),
  ).toBe(
    'Update marker "Hook": name to "Opening"; position to 00:00:04:00; note to "Brand safety warning"; duration to 00:00:02:00; color to red',
  );
  expect(
    editLabel(
      [CommandSchema.parse({ type: "setMarker", id: "hook", note: "" })],
      before,
      "Edit",
      "pending",
    ),
  ).toBe('Update marker "Hook": clear note');
});

test("creating a track includes its supplied name and settings", () => {
  expect(
    editLabel(
      [
        CommandSchema.parse({
          type: "setTrack",
          index: 3,
          kind: "audio",
          name: "Music",
          locked: true,
          muted: true,
          enabled: false,
          autoSelect: false,
          solo: true,
        }),
      ],
      timeline,
      "Edit",
      "pending",
    ),
  ).toBe(
    "Add audio track 3; Rename track to Music; Lock track; Disable track; Disable track auto-select; Mute track; Solo track",
  );
});

test("missing composition context uses track indices and neutral marker wording", () => {
  expect(
    editLabel(
      [CommandSchema.parse({ type: "removeTrack", index: 2 })],
      undefined,
      "Edit",
      "pending",
    ),
  ).toBe("Remove empty track 2");
  expect(
    editLabel(
      [
        CommandSchema.parse({
          type: "setMarker",
          id: "hook",
          note: "new note",
        }),
      ],
      undefined,
      "Edit",
      "pending",
    ),
  ).toBe('Set marker: note to "new note"');
});
