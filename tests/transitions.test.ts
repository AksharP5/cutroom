import { expect, test } from "bun:test";
import { applyAll, canonicalTimeline } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import { editLabel } from "../src/shared/timeline/labels";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput, Transition } from "../src/shared/timeline/schema";
import {
  parseComposition,
  patchComposition,
  settingsOf,
  timelineContent,
} from "../src/server/timeline/composition";
import { countingIds } from "./clip-ids";

const mediaLengths = new Map([["talk.mp4", 20]]);
const page = (body: string) =>
  `<!doctype html>\n<html><head></head>\n<body><main id="main" data-composition-id="main" data-duration="12" data-fps="30">\n${body}\n</main></body></html>\n`;
// Two shots from one interview: a has 6 s of media past its out point, b has 4 s before its in.
const shots = page(
  [
    `<video id="a" src="talk.mp4" muted data-start="0" data-duration="3" data-media-start="1" data-track-index="0" data-link="la"></video>`,
    `<video id="b" src="talk.mp4" muted data-start="3" data-duration="3" data-media-start="4" data-track-index="0" data-link="lb"></video>`,
    `<audio id="sa" src="talk.mp4" data-start="0" data-duration="3" data-media-start="1" data-track-index="1" data-link="la"></audio>`,
    `<audio id="sb" src="talk.mp4" data-start="3" data-duration="3" data-media-start="4" data-track-index="1" data-link="lb"></audio>`,
  ].join("\n"),
);

const parse = (html: string) =>
  parseComposition(html, emptyTimelineSettings(), { mediaLengths });
const edit = (html: string, commands: CommandInput[]) => {
  const parsed = parse(html);
  const origins = new Map<string, ClipOrigin>();
  const timeline = canonicalTimeline(
    applyAll(
      parsed.timeline,
      commands.map((command) => CommandSchema.parse(command)),
      {
        onCreate: (id, origin) => origins.set(id, origin),
        newId: countingIds,
      },
    ),
  );
  const output = patchComposition(parsed, timeline, origins);
  // What was written reads back as exactly the timeline the engine produced.
  expect(
    timelineContent(
      parseComposition(output, settingsOf(timeline), { mediaLengths }).timeline,
    ),
  ).toEqual(timelineContent(timeline));
  return output;
};
const clips = (html: string) =>
  Object.fromEntries(parse(html).timeline.clips.map((clip) => [clip.id, clip]));
const tag = (html: string, id: string) =>
  new RegExp(`<(?:video|audio) id="${id}"[^>]*>`).exec(html)![0];
const dissolve = (
  duration: number,
  alignment: Transition["alignment"] = "center",
): Extract<CommandInput, { type: "setTransition" }> => ({
  type: "setTransition",
  from: "a",
  to: "b",
  transition: { duration, alignment },
});
const second: Transition = {
  kind: "dissolve",
  duration: 30,
  alignment: "center",
};

test("a transition runs each clip's media past the cut, reads back as the same cut, and removing it restores the source", () => {
  const html = edit(shots, [dissolve(30)]);
  expect(tag(html, "a")).toBe(
    `<video id="a" src="talk.mp4" muted data-start="0" data-duration="3.5" data-media-start="1" data-track-index="0" data-link="la" data-transition-out="dissolve" data-transition-out-duration="1" data-transition-out-align="center" data-transition-out-under="">`,
  );
  expect(tag(html, "b")).toBe(
    `<video id="b" src="talk.mp4" muted data-start="2.5" data-duration="3.5" data-media-start="3.5" data-track-index="0" data-link="lb" data-transition-in="dissolve" data-transition-in-duration="1" data-transition-in-align="center">`,
  );
  expect(html.split("data-cutroom-transitions").length).toBe(2);
  const read = clips(html);
  expect(
    [read.a, read.b].map(({ start, duration, mediaStart }) => [
      start,
      duration,
      mediaStart,
    ]),
  ).toEqual([
    [0, 90, 1],
    [90, 90, 4],
  ]);
  expect([read.a!.transitionOut, read.b!.transitionIn]).toEqual([
    second,
    second,
  ]);

  const removed = edit(html, [{ ...dissolve(30), transition: null }]);
  expect(
    removed.replace(/<style data-cutroom-transitions[\s\S]*?<\/style>\n/, ""),
  ).toBe(shots);
  expect(
    editLabel(
      [CommandSchema.parse(dissolve(30))],
      parse(shots).timeline,
      "",
      "done",
    ),
  ).toBe("Added 1 s cross dissolve between talk.mp4 and talk.mp4");
});

test("a transition longer than the media past the cut is refused with the longest that fits, which then applies", () => {
  const short = shots.replace(
    'id="b" src="talk.mp4" muted data-start="3" data-duration="3" data-media-start="4"',
    'id="b" src="talk.mp4" muted data-start="3" data-duration="3" data-media-start="0.2"',
  );
  expect(() => edit(short, [dissolve(30)])).toThrow(
    "Only 13 frames fit at this cut: talk.mp4 has 6 frames of media before its in point.",
  );
  expect(() => edit(short, [dissolve(7, "end")])).toThrow("Only 6 frames fit");
  // Starting on the cut needs no media before it.
  expect(clips(edit(short, [dissolve(60, "start")])).b!.transitionIn).toEqual({
    kind: "dissolve",
    duration: 60,
    alignment: "start",
  });
  expect(clips(edit(short, [dissolve(13)])).b!.transitionIn?.duration).toBe(13);
  // A still has no end to run out of.
  const stills = page(
    `<img id="a" class="clip" src="a.png" data-start="0" data-duration="3" data-track-index="0">\n<img id="b" class="clip" src="b.png" data-start="3" data-duration="3" data-track-index="0">`,
  );
  expect(clips(edit(stills, [dissolve(90)])).a!.transitionOut?.duration).toBe(
    90,
  );
});

test("razor, roll and trims keep a transition on its cut; trimming into it shortens it; moving or deleting a clip removes it", () => {
  const html = edit(shots, [dissolve(30)]);
  // A razor through a leaves the transition on the piece that still meets b, and none at the razor.
  const razored = clips(
    edit(html, [{ type: "split", at: 30, clipIds: ["a"] }]),
  );
  expect(
    Object.values(razored).flatMap((clip) =>
      clip.transitionIn || clip.transitionOut ? [clip.id] : [],
    ),
  ).toEqual(["a-2", "b", "sa-2", "sb"]);
  // A roll moves the cut and the transition with it.
  const rolled = clips(
    edit(html, [
      { type: "trim", clipId: "b", edge: "start", to: 100 },
      { type: "trim", clipId: "a", edge: "end", to: 100 },
    ]),
  );
  expect([rolled.a!.duration, rolled.b!.transitionIn]).toEqual([100, second]);
  // b keeps 15 frames of its own after the cut, so its tail trims the transition down to fit.
  const trimmed = clips(
    edit(html, [{ type: "trim", clipId: "b", edge: "end", to: 100 }]),
  );
  expect([
    trimmed.a!.transitionOut?.duration,
    trimmed.b!.transitionIn?.duration,
  ]).toEqual([20, 20]);
  for (const commands of [
    [{ type: "trim", clipId: "a", edge: "end", to: 80 }],
    [{ type: "move", clipIds: ["b"], by: 30 }],
    [{ type: "remove", clipIds: ["a"], ripple: true }],
  ] satisfies CommandInput[][]) {
    const after = clips(edit(html, commands));
    expect(
      Object.values(after).some(
        (clip) => clip.transitionIn || clip.transitionOut,
      ),
    ).toBe(false);
  }
  // Lifting a clip shortens its partner back to the cut.
  expect(tag(edit(html, [{ type: "remove", clipIds: ["a"] }]), "b")).toBe(
    `<video id="b" src="talk.mp4" muted data-start="3" data-duration="3" data-media-start="4" data-track-index="0" data-link="lb">`,
  );
});

test("linked sound crossfades on a quarter sine, a dip draws on both clips, and the later clip in the source fades", () => {
  const html = edit(shots, [dissolve(30)]);
  const read = clips(html);
  expect([read.sa!.transitionOut, read.sb!.transitionIn]).toEqual([
    second,
    second,
  ]);
  // The envelope is the transition's, not clip automation, so the clips read without one.
  expect([read.sa!.automation, read.sb!.automation, read.sb!.fadeIn]).toEqual([
    null,
    null,
    0,
  ]);
  const envelope = JSON.parse(
    /id="sb"[^>]*data-automation="([^"]*)"/
      .exec(html)![1]!
      .replaceAll("&quot;", '"'),
  ) as { lanes: { points: { t: number; v: number }[] }[] };
  const points = envelope.lanes[0]!.points;
  expect(points.slice(0, 5)).toEqual([
    { t: 0, v: 0 },
    { t: 0.125, v: 0.19509 },
    { t: 0.25, v: 0.382683 },
    { t: 0.375, v: 0.55557 },
    { t: 0.5, v: 0.707107 },
  ]);

  const dip = edit(shots, [
    { ...dissolve(30), transition: { kind: "dip", duration: 30 } },
  ]);
  expect(dip.match(/<(video|audio)[^>]*-under/g)).toBeNull();
  expect(tag(dip, "a")).toContain('data-transition-out="dip"');

  // With b first in the source, a is drawn on top, so a fades out over b instead.
  const reordered = shots.replace(
    /(<video id="a"[^\n]*\n)(<video id="b"[^\n]*\n)/,
    "$2$1",
  );
  const flipped = edit(reordered, [dissolve(30)]);
  expect(tag(flipped, "b")).toContain('data-transition-in-under=""');
  expect(tag(flipped, "a")).not.toContain("-under");
});

test("a transition's edge owns its fade, and transitions join only cuts between media", () => {
  const html = edit(shots, [dissolve(30)]);
  expect(() =>
    edit(html, [{ type: "setClip", clipId: "sb", fadeIn: 10 }]),
  ).toThrow("talk.mp4 has a transition on that edge");
  expect(() =>
    edit(shots, [
      {
        type: "setTransition",
        from: "a",
        to: "sb",
        transition: { duration: 10 },
      },
    ]),
  ).toThrow("talk.mp4 does not end where talk.mp4 starts on the same track.");
});
