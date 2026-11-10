import { expect, test } from "bun:test";
import { audioDbToGain, MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import { parseAudioElements } from "@hyperframes/engine";
import { applyAll } from "../src/shared/timeline/apply";
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
import { withPreviewBridge } from "../src/server/hyperframes/previewBridge";

const html = `<main data-composition-id="main" data-duration="10" data-fps="30000/1001"><audio id="music" src="music.wav" data-start="0" data-duration="10"></audio><video id="voice" src="voice.mp4" data-start="0" data-duration="10" data-track-index="1"></video></main>`;

test("gain and frame fades round-trip exactly through HTML and the producer's audio reader", () => {
  let parsed = parseComposition(html, emptyTimelineSettings());
  for (const volume of [
    audioDbToGain(-42.3),
    audioDbToGain(-12),
    MAX_AUDIO_GAIN,
    0,
    null,
  ]) {
    const commands: CommandInput[] = ["music", "voice"].map((clipId) => ({
      type: "setClip",
      clipId,
      volume,
      fadeIn: 1,
      fadeOut: 37,
    }));
    const next = applyAll(
      parsed.timeline,
      commands.map((command) => CommandSchema.parse(command)),
    );
    const patched = patchComposition(parsed, next, new Map());
    parsed = parseComposition(patched, settingsOf(next));
    expect(parsed.timeline).toEqual(next);
    expect(patched).toContain('data-fade-in="0.033367"');
    for (const audio of parseAudioElements(patched)) {
      expect(audio.volume).toBe(volume ?? 1);
      expect(audio.fadeIn).toBe(0.033367);
      expect(audio.fadeOut).toBe(1.234567);
    }
  }
  const cleared = applyAll(parsed.timeline, [
    CommandSchema.parse({
      type: "setClip",
      clipId: "music",
      fadeIn: 0,
      fadeOut: 0,
    }),
  ]);
  expect(
    parseComposition(
      patchComposition(parsed, cleared, new Map()),
      settingsOf(cleared),
    ).timeline,
  ).toEqual(cleared);
  expect(() =>
    applyAll(cleared, [
      CommandSchema.parse({
        type: "setClip",
        clipId: "music",
        fadeIn: 300,
        fadeOut: 1,
      }),
    ]),
  ).toThrow("Fades must fit inside the clip");
});

test("preview media opts into the opaque frame's CORS audio path without changing script strings", () => {
  const source =
    '<html><head><script>const tag = "<audio>";</script></head><body><video src="voice.mp4"></video><audio crossorigin="use-credentials" src="other.wav"></audio></body></html>';
  const preview = withPreviewBridge(source);
  expect(preview).toContain('<video crossorigin="anonymous" src="voice.mp4">');
  expect(preview).toContain(
    '<audio crossorigin="use-credentials" src="other.wav">',
  );
  expect(preview).toContain('const tag = "<audio>"');
});
