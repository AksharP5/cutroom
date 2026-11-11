import { expect, test } from "bun:test";
import { parseAudioElements } from "@hyperframes/engine";
import { applyAll } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { newTrack } from "../src/shared/timeline/tracks";
import {
  parseComposition,
  mixCompositionInstances,
  patchComposition,
  settingsOf,
} from "../src/server/timeline/composition";

const source = `<main id="main" data-composition-id="main" data-duration="10" data-fps="30000/1001">
<video id="picture" src="picture.mp4" muted data-start="0" data-duration="3.003" data-track-index="0"></video>
<audio id="voice" src="voice.wav" data-start="0" data-duration="3.003" data-track-index="1" data-volume="0.4"></audio>
<audio id="music" src="music.wav" data-start="0" data-duration="6.006" data-track-index="2"></audio>
<audio id="off" src="voice.wav" data-start="7.007" data-duration="1.001" data-track-index="1" data-hidden></audio>
</main>`;

test("preview readback applies each scene's mix to every bundled instance", () => {
  const settings = emptyTimelineSettings();
  settings.tracks = [
    { ...newTrack(0, "audio"), name: "Voice", solo: true },
    { ...newTrack(1, "audio"), name: "Music" },
  ];
  const html = `<main data-composition-id="main" data-duration="4">
  <audio id="parent-sound" src="parent.wav" data-start="0" data-duration="4" data-track-index="1"></audio>
  ${["scene-1", "scene-2"]
    .map(
      (
        id,
      ) => `<div data-composition-id="${id}" data-hf-original-composition-id="main" data-composition-file="./scene.html" data-start="0" data-duration="2">
  <audio id="${id}-voice" src="voice.wav" data-start="0" data-duration="2" data-track-index="0"></audio>
  <audio id="${id}-music" src="music.wav" data-start="0" data-duration="2" data-track-index="1"></audio></div>`,
    )
    .join("")}</main>`;
  const mixed = mixCompositionInstances(
    html,
    settings,
    "scene.html",
    "index.html",
    new Map(),
  );
  expect(parseAudioElements(mixed).map(({ id }) => id)).toEqual([
    "parent-sound",
    "scene-1-voice",
    "scene-2-voice",
  ]);
  expect(
    mixCompositionInstances(
      mixed,
      settings,
      "scene.html",
      "index.html",
      new Map(),
    ),
  ).toBe(mixed);
});

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

test("a linked insert reuses free picture-sound tracks, or creates one, and exports sound once", () => {
  const parsed = parseComposition(
    source
      .replace('id="picture"', 'id="picture" data-link="original"')
      .replace('id="voice"', 'id="voice" data-link="original"')
      .replace(/\n<audio id="off"[^>]*><\/audio>/, ""),
    emptyTimelineSettings(),
  );
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

test("overwrite reuses picture sound tracks while leaving Music and VO alone", () => {
  const parsed = parseComposition(
    `<main id="main" data-composition-id="main" data-duration="12">
    <video id="interview" src="interview.mp4" muted data-link="interview" data-start="0" data-duration="3" data-track-index="0"></video>
    <audio id="location" src="interview.mp4" data-link="interview" data-start="0" data-duration="10" data-track-index="1"></audio>
    <audio id="music" src="music.wav" data-start="0" data-duration="3" data-track-index="2"></audio>
    <audio id="vo" src="voice.wav" data-link="audio-only" data-start="0" data-duration="3" data-track-index="3"></audio>
    </main>`,
    emptyTimelineSettings(),
  );
  const named = applyAll(parsed.timeline, [
    CommandSchema.parse({ type: "setTrack", index: 2, name: "Music" }),
    CommandSchema.parse({ type: "setTrack", index: 3, name: "VO" }),
  ]);
  const insert = CommandSchema.parse({
    type: "insert",
    track: 0,
    at: 180,
    mode: "overwrite",
    clip: { id: "second", kind: "video", src: "second.mp4", duration: 60 },
  });
  const added = applyAll(named, [insert]);
  expect(
    added.clips.find((clip) => clip.link === "second" && clip.kind === "audio")
      ?.track,
  ).toBe(1);
  expect(added.tracks).toEqual(named.tracks);
  expect(added.clips.find((clip) => clip.id === "music")).toEqual(
    named.clips.find((clip) => clip.id === "music"),
  );
  const empty = applyAll(named, [
    CommandSchema.parse({ type: "setTrack", index: 5, kind: "audio" }),
    insert,
  ]);
  expect(
    empty.clips.find((clip) => clip.link === "second" && clip.kind === "audio")
      ?.track,
  ).toBe(1);
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

test("mute and solo suppress embedded video sound without hiding picture or losing authored mute and gain", () => {
  let parsed = parseComposition(
    source.replace(
      'src="picture.mp4" muted',
      'src="picture.mp4" data-has-audio="true" data-volume="0.5"',
    ),
    emptyTimelineSettings(),
  );
  const edit = (...commands: CommandInput[]) => {
    const timeline = applyAll(
      parsed.timeline,
      commands.map((command) => CommandSchema.parse(command)),
    );
    const html = patchComposition(parsed, timeline, new Map());
    parsed = parseComposition(html, settingsOf(timeline));
    expect(parsed.timeline).toEqual(timeline);
    expect(
      parsed.timeline.clips.find((clip) => clip.id === "picture"),
    ).toMatchObject({ hasAudio: true, enabled: true, volume: 0.5 });
    expect(html).not.toMatch(/id="picture"[^>]*data-hidden/);
    return html;
  };
  let html = edit({ type: "setTrack", index: 0, muted: true });
  expect(html).toMatch(/id="picture"[^>]*muted="" data-cutroom-muted=""/);
  expect(parseAudioElements(html).map((audio) => audio.src)).not.toContain(
    "picture.mp4",
  );
  html = edit(
    { type: "setTrack", index: 0, muted: false },
    { type: "setTrack", index: 1, solo: true },
  );
  expect(parseAudioElements(html).map((audio) => audio.id)).toEqual(["voice"]);
  html = edit({ type: "setTrack", index: 1, solo: false });
  expect(html).not.toMatch(/id="picture"[^>]*data-cutroom-muted/);
  expect(html).not.toMatch(/id="picture"[^>]*\bmuted/);
  expect(
    parseAudioElements(html).find((audio) => audio.src === "picture.mp4")
      ?.volume,
  ).toBe(0.5);

  // Authored mute is not owned by the track override and must survive toggling a solo.
  const authored = parseComposition(
    source.replace('id="music"', 'id="music" muted'),
    emptyTimelineSettings(),
  );
  const solo = applyAll(authored.timeline, [
    CommandSchema.parse({ type: "setTrack", index: 1, solo: true }),
  ]);
  const suppressed = parseComposition(
    patchComposition(authored, solo, new Map()),
    settingsOf(solo),
  );
  const restored = applyAll(suppressed.timeline, [
    CommandSchema.parse({ type: "setTrack", index: 1, solo: false }),
  ]);
  const normal = patchComposition(suppressed, restored, new Map());
  expect(normal).toMatch(/id="picture"[^>]*\bmuted/);
  expect(normal).toContain('<audio id="music" muted src="music.wav"');
  expect(normal).not.toMatch(/id="music"[^>]*data-cutroom-muted/);
  expect(parseComposition(normal, settingsOf(restored)).timeline).toEqual(
    restored,
  );
});
