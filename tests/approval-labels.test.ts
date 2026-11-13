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
  ).toBe('Add marker "Hook" at frame 72');
  expect(
    editLabel(
      [CommandSchema.parse({ type: "move", clipIds: ["opaque-id"], by: -24 })],
      undefined,
      "Edit",
      "pending",
    ),
  ).toBe("Move a clip 24 frames left");
});
