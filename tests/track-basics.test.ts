import { parseHTML } from "linkedom";
import { expect, test } from "bun:test";
import { parseAudioElements } from "@hyperframes/engine";
import { applyAll } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import {
  CommandSchema,
  emptyTimelineSettings,
} from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { editLabel } from "../src/shared/timeline/labels";
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

test("overwrite never cuts another pair's sound, and reuses a free picture sound track while leaving Music and VO alone", () => {
  const composition = `<main id="main" data-composition-id="main" data-duration="12">
    <video id="interview" src="interview.mp4" muted data-link="interview" data-start="0" data-duration="3" data-track-index="0"></video>
    <audio id="location" src="interview.mp4" data-link="interview" data-start="0" data-duration="10" data-track-index="1"></audio>
    <audio id="music" src="music.wav" data-start="0" data-duration="3" data-track-index="2"></audio>
    <audio id="vo" src="voice.wav" data-link="audio-only" data-start="0" data-duration="3" data-track-index="3"></audio>
    </main>`;
  const parsed = parseComposition(composition, emptyTimelineSettings());
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
  // The interview's location sound still runs under the drop, so its track isn't free.
  const added = applyAll(named, [insert]);
  const sound = added.clips.find(
    (clip) => clip.link === "second" && clip.kind === "audio",
  );
  expect(sound?.track).not.toBe(1);
  for (const id of ["location", "music", "vo"])
    expect(added.clips.find((clip) => clip.id === id)).toEqual(
      named.clips.find((clip) => clip.id === id),
    );
  // An empty audio track is free, so the sound goes there rather than on Music or VO.
  const empty = applyAll(named, [
    CommandSchema.parse({ type: "setTrack", index: 5, kind: "audio" }),
    insert,
  ]);
  expect(
    empty.clips.find((clip) => clip.link === "second" && clip.kind === "audio")
      ?.track,
  ).toBe(5);
  // When the location sound ends before the drop, its picture sound track is free and reused.
  const shorter = applyAll(
    parseComposition(
      composition.replace(
        'data-start="0" data-duration="10" data-track-index="1"',
        'data-start="0" data-duration="5" data-track-index="1"',
      ),
      emptyTimelineSettings(),
    ).timeline,
    [insert],
  );
  expect(
    shorter.clips.find(
      (clip) => clip.link === "second" && clip.kind === "audio",
    )?.track,
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

test("track gain plays on top of each clip's gain and leaves the clip's own gain as authored", () => {
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
  const played = (html: string) =>
    Object.fromEntries(
      parseAudioElements(html).map((audio) => [audio.id, audio.volume]),
    );
  const own = () =>
    Object.fromEntries(
      parsed.timeline.clips.map((clip) => [clip.id, clip.volume]),
    );

  // History and approvals say which track, in dB.
  expect(
    editLabel(
      [CommandSchema.parse({ type: "setTrack", index: 2, volume: 0.125 })],
      parsed.timeline,
      "Edit",
      "done",
    ),
  ).toBe("Set A2 gain to -18.1 dB");
  const named = applyAll(parsed.timeline, [
    CommandSchema.parse({ type: "setTrack", index: 2, name: "Music bed" }),
  ]);
  expect(
    editLabel(
      [
        CommandSchema.parse({
          type: "setTrack",
          index: 2,
          volume: 10 ** (-18 / 20),
        }),
      ],
      named,
      "Edit",
    ),
  ).toBe("Set Music bed gain to -18 dB");

  // A split music bed is turned down once, on its track.
  let html = edit(
    { type: "split", at: 60, clipIds: ["music"], ids: { music: ["bed-2"] } },
    { type: "setTrack", index: 2, volume: 0.25 },
    { type: "setTrack", index: 1, volume: 0.5 },
  );
  expect(played(html)).toEqual({ voice: 0.4, music: 1, "bed-2": 1 });
  const group = (source: string, track: number) =>
    parseHTML(source).document.querySelector(
      `hf-audio-group[data-cutroom-track="${track}"]`,
    )!;
  expect(group(html, 2).getAttribute("data-volume")).toBe("0.25");
  expect(
    parseHTML(html)
      .document.getElementById("bed-2")!
      .getAttribute("data-audio-group"),
  ).toBe(group(html, 2).id);
  expect(own()).toMatchObject({ voice: 0.4, music: null, "bed-2": null });

  // Clip gain still changes on its own, and a piece cut afterwards plays at the same level.
  html = edit(
    { type: "setClip", clipId: "music", volume: 2 },
    { type: "split", at: 30, clipIds: ["music"], ids: { music: ["bed-1"] } },
  );
  expect(played(html)).toMatchObject({ music: 2, "bed-1": 2 });
  expect(own()).toMatchObject({ music: 2, "bed-1": 2, "bed-2": null });

  // Clip and track gains remain separate, so their product has no combined +12 dB cap.
  html = edit({ type: "setTrack", index: 2, volume: 3 });
  expect(played(html).music).toBe(2);
  expect(group(html, 2).getAttribute("data-volume")).toBe("3");
  expect(own().music).toBe(2);

  // Settings changed outside an edit reach the preview and the render without a write.
  const outside = settingsOf(parsed.timeline);
  outside.tracks = outside.tracks.map((track) =>
    track.index === 2 ? { ...track, volume: 0.1 } : track,
  );
  const mixed = mixCompositionInstances(
    html,
    outside,
    "index.html",
    "index.html",
    new Map(),
  );
  expect(played(mixed)).toMatchObject({ voice: 0.4, music: 2, "bed-2": 1 });
  expect(group(mixed, 2).getAttribute("data-volume")).toBe("0.1");

  // Back at 0 dB the source carries only what the clips were given.
  html = edit(
    { type: "setTrack", index: 2, volume: 1 },
    { type: "setTrack", index: 1, volume: 1 },
  );
  expect(html).not.toContain("data-cutroom-volume");
  expect(played(html)).toEqual({
    voice: 0.4,
    music: 2,
    "bed-1": 2,
    "bed-2": 1,
  });
  expect(html).toMatch(/id="bed-2"(?![^>]*data-volume)/);
});

test("a gained track preserves outside clip gain and authored groups, and edits one attribute at 500 clips", () => {
  const source = `<main data-composition-id="main" data-duration="5"><hf-audio-group id="authored" data-volume="0.8"></hf-audio-group>${Array.from({ length: 500 }, (_, i) => `<audio id="clip-${i}" src="voice.wav" data-start="0" data-duration="5" data-track-index="1" data-volume="0.4"${i === 0 ? ' data-audio-group="authored"' : ""}></audio>`).join("")}</main>`;
  let parsed = parseComposition(source, emptyTimelineSettings());
  const edit = (volume: number) => {
    const after = applyAll(parsed.timeline, [
      CommandSchema.parse({ type: "setTrack", index: 1, volume }),
    ]);
    const html = patchComposition(parsed, after, new Map());
    parsed = parseComposition(html, settingsOf(after));
    return html;
  };
  const before = edit(0.5);
  const after = edit(0.25);
  expect(after).toBe(
    before.replace(
      'data-cutroom-track="1" data-volume="0.5"',
      'data-cutroom-track="1" data-volume="0.25"',
    ),
  );
  expect(parsed.timeline.clips[0]!.trackGainWarning).toContain(
    'authored audio group "authored"',
  );
  const document = parseHTML(after).document;
  expect(
    document.getElementById("clip-0")!.getAttribute("data-audio-group"),
  ).toBe("authored");
  expect(
    document.getElementById("clip-1")!.getAttribute("data-audio-group"),
  ).toBe("cutroom-main-track-1");
  document.getElementById("clip-1")!.setAttribute("data-volume", "0.7");
  parsed = parseComposition(document.toString(), settingsOf(parsed.timeline));
  const outside = edit(0.1);
  expect(
    parseHTML(outside)
      .document.getElementById("clip-1")!
      .getAttribute("data-volume"),
  ).toBe("0.7");
  expect(parsed.timeline.clips[1]!.volume).toBe(0.7);
});
