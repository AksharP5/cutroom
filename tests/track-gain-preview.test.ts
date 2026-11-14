import { expect, test } from "bun:test";
import { trackGainPreview } from "../src/server/hyperframes/trackGainPreview";

const html = `<html><head><meta name="hyperframes-project-signature" content="before"></head><body><main><hf-audio-group id="track" data-cutroom-track="1" data-hf-id="generated" data-volume="0.5"></hf-audio-group><audio id="clip" data-hf-id="clip-identity" data-hf-group-render-id="track" data-audio-group="track" data-volume="0.4"></audio><hf-audio-group id="authored" data-volume="0.7"></hf-audio-group><script>const level = 1;</script></main></body></html>`;

test("only managed faders and compiler routing metadata may reuse a playing preview", () => {
  const before = trackGainPreview(html);
  const after = trackGainPreview(
    html
      .replace('content="before"', 'content="after"')
      .replace('data-hf-id="generated"', 'data-hf-id="regenerated"')
      .replace('data-volume="0.5"', 'data-volume="0.25"'),
  );
  expect(after.signature).toBe(before.signature);
  expect(
    trackGainPreview(
      html.replace(
        'id="clip" data-hf-id="clip-identity"',
        'data-hf-id="clip-identity" id="clip"',
      ),
    ).signature,
  ).toBe(before.signature);
  expect(after.gains).toEqual([{ id: "track", volume: 0.25 }]);
  for (const changed of [
    html.replace('data-volume="0.4"', 'data-volume="0.2"'),
    html.replace('data-volume="0.7"', 'data-volume="0.2"'),
    html.replace("clip-identity", "authored-new-identity"),
    html.replace("const level = 1", "const level = 2"),
    html.replace('data-audio-group="track"', 'data-audio-group="authored"'),
  ])
    expect(trackGainPreview(changed).signature).not.toBe(before.signature);
});
