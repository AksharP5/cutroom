import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { voiceoverWav } from "../src/shared/voiceover";
import type { PcmBlock } from "../src/shared/voiceover";

const worklet = await readFile(
  new URL("../src/client/voiceover/pcm-worklet.js", import.meta.url),
  "utf8",
);

test("a missing render quantum stays a gap instead of shifting captured samples", () => {
  const blocks: PcmBlock[] = [];
  let create = () => ({ process(_inputs: Float32Array[][]) {} });
  const clock = {
    currentFrame: 0,
    AudioWorkletProcessor: class {
      port = {
        postMessage: (block: PcmBlock) => blocks.push(structuredClone(block)),
      };
    },
    registerProcessor(
      _name: string,
      Processor: new () => ReturnType<typeof create>,
    ) {
      create = () => new Processor();
    },
  };
  runInNewContext(worklet, clock);
  const recorder = create();
  const quantum = new Float32Array(128).fill(0.25);
  // One captured quantum, then one missing quantum, then enough input to flush a block.
  recorder.process([[quantum]]);
  for (let frame = 256; frame < 256 + 2048; frame += 128) {
    clock.currentFrame = frame;
    recorder.process([[quantum]]);
  }
  const { bytes, droppedSamples } = voiceoverWav(blocks, 0, 2048, 48000);
  expect(droppedSamples).toBe(128);
  const samples = new Int16Array(bytes, 44);
  expect(Array.from(samples.subarray(0, 128))).toEqual(
    new Array(128).fill(8192),
  );
  expect(Array.from(samples.subarray(128, 256))).toEqual(
    new Array(128).fill(0),
  );
  expect(Array.from(samples.subarray(256))).toEqual(new Array(1792).fill(8192));
  // A later window still has the samples at their real audio-clock positions.
  const later = new DataView(voiceoverWav(blocks, 256, 2048, 48000).bytes);
  expect(later.getInt16(44, true)).toBe(8192);
  expect(later.getInt16(44 + 2047 * 2, true)).toBe(8192);
});
