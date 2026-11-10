import { expect, test } from "bun:test";
import { parseAudioElements } from "@hyperframes/engine";
import { applyAll } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import {
  parseComposition,
  patchComposition,
  settingsOf,
} from "../src/server/timeline/composition";

const source = `<main id="main" data-composition-id="main" data-duration="10" data-fps="30000/1001">
<video id="picture" src="picture.mp4" muted data-start="0" data-duration="3.003" data-track-index="0"></video>
<audio id="voice" src="voice.wav" data-start="0" data-duration="3.003" data-track-index="1" data-volume="0.4"></audio>
<audio id="music" src="music.wav" data-start="0" data-duration="6.006" data-track-index="2"></audio>
<audio id="off" src="voice.wav" data-start="7.007" data-duration="1.001" data-track-index="1" data-hidden></audio>
</main>`;

test("track enable, mute and multiple solos persist exactly without changing clip gain or enable", () => {
  let parsed = parseComposition(source, emptyTimelineSettings());
  const edit = (...commands: CommandInput[]) => {
    const origins = new Map<string, ClipOrigin>();
    const timeline = applyAll(
      parsed.timeline,
      commands.map((command) => CommandSchema.parse(command)),
      { onCreate: (id, origin) => origins.set(id, origin) },
    );
    const html = patchComposition(parsed, timeline, origins);
    parsed = parseComposition(html, settingsOf(timeline));
    expect(parsed.timeline).toEqual(timeline);
    return html;
  };
  let html = edit(
    { type: "setTrack", index: 0, name: "Picture", enabled: false },
    { type: "setTrack", index: 2, name: "Music", muted: true },
  );
  expect(parseAudioElements(html).map((audio) => audio.id)).toEqual(["voice"]);
  expect(html).toMatch(/id="picture"[^>]*data-hidden/);
  expect(
    parsed.timeline.clips.find((clip) => clip.id === "picture")?.enabled,
  ).toBe(true);
  expect(parsed.timeline.clips.find((clip) => clip.id === "off")?.enabled).toBe(
    false,
  );
  html = edit({ type: "setTrack", index: 2, solo: true, muted: false });
  expect(parseAudioElements(html).map((audio) => audio.id)).toEqual(["music"]);
  html = edit({ type: "setTrack", index: 1, solo: true });
  expect(
    parseAudioElements(html).map((audio) => [audio.id, audio.volume]),
  ).toEqual([
    ["voice", 0.4],
    ["music", 1],
  ]);
  html = edit({ type: "setTrack", index: 1, muted: true });
  expect(parseAudioElements(html).map((audio) => audio.id)).toEqual(["music"]);
  html = edit(
    { type: "setTrack", index: 1, solo: false, muted: false },
    { type: "setTrack", index: 2, solo: false },
    { type: "setTrack", index: 0, enabled: true },
  );
  expect(html).not.toContain("data-cutroom-track-hidden");
  expect(html).toContain('data-volume="0.4"');
  expect(parsed.timeline.clips.find((clip) => clip.id === "off")?.enabled).toBe(
    false,
  );
  // A clip-level edit while its track is off must also survive re-enabling the track.
  edit(
    { type: "setTrack", index: 1, muted: true },
    { type: "setClip", clipId: "voice", enabled: false },
  );
  html = edit({ type: "setTrack", index: 1, muted: false });
  expect(parseAudioElements(html).map((audio) => audio.id)).toEqual(["music"]);
});

test("a linked insert uses the first free unlocked audio track, or creates one, and exports sound once", () => {
  const parsed = parseComposition(source, emptyTimelineSettings());
  const insert = CommandSchema.parse({
    type: "insert",
    track: 0,
    at: 90,
    clip: {
      id: "new-picture",
      kind: "video",
      src: "new.mp4",
      duration: 90,
      mediaStart: 1.001,
    },
    linkedAudio: { id: "new-sound" },
  });
  const origins = new Map<string, ClipOrigin>();
  const timeline = applyAll(parsed.timeline, [insert], {
    onCreate: (id, origin) => origins.set(id, origin),
  });
  expect(timeline.clips.find((clip) => clip.id === "new-sound")).toMatchObject({
    track: 1,
    link: "new-picture",
    mediaStart: 1.001,
    start: 90,
    duration: 90,
  });
  expect(
    timeline.clips.find((clip) => clip.id === "new-picture"),
  ).toMatchObject({ hasAudio: false, link: "new-picture" });
  const html = patchComposition(parsed, timeline, origins);
  expect(parseComposition(html, settingsOf(timeline)).timeline).toEqual(
    timeline,
  );
  expect(html).toMatch(/<video[^>]*id="new-picture"[^>]*muted/);
  expect(
    parseAudioElements(html)
      .filter((audio) => audio.src === "new.mp4")
      .map((audio) => audio.id),
  ).toEqual(["new-sound"]);
  const locked = applyAll(parsed.timeline, [
    CommandSchema.parse({ type: "setTrack", index: 1, locked: true }),
    insert,
  ]);
  expect(locked.tracks.at(-1)).toMatchObject({ index: 3, kind: "audio" });
  expect(locked.clips.find((clip) => clip.id === "new-sound")?.track).toBe(3);
  const silent = applyAll(parsed.timeline, [insert], {
    silentMedia: new Set(["new.mp4"]),
  });
  expect(silent.clips.some((clip) => clip.id === "new-sound")).toBe(false);
  expect(silent.clips.find((clip) => clip.id === "new-picture")?.hasAudio).toBe(
    false,
  );
});

test("adding an empty track and a clip on it is an exact command batch, including a muted destination", () => {
  const parsed = parseComposition(source, emptyTimelineSettings());
  const origins = new Map<string, ClipOrigin>();
  const timeline = applyAll(
    parsed.timeline,
    [
      CommandSchema.parse({
        type: "setTrack",
        index: 3,
        kind: "audio",
        name: "Effects",
        muted: true,
      }),
      CommandSchema.parse({
        type: "insert",
        track: 3,
        at: 0,
        clip: { id: "effect", kind: "audio", src: "effect.wav", duration: 30 },
      }),
    ],
    { onCreate: (id, origin) => origins.set(id, origin) },
  );
  const html = patchComposition(parsed, timeline, origins);
  expect(parseComposition(html, settingsOf(timeline)).timeline).toEqual(
    timeline,
  );
  expect(parseAudioElements(html).map((audio) => audio.id)).not.toContain(
    "effect",
  );
});
