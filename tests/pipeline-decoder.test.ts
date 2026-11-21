import { expect, test } from "bun:test";
import { SourceDecoder } from "../src/client/pipeline/decoder";
import type { VideoTrack } from "../src/client/pipeline/mp4";

test("a picture request runs before the rest of an already-running lookahead", async () => {
  const nativeDecoder = Object.getOwnPropertyDescriptor(
    globalThis,
    "VideoDecoder",
  );
  const nativeChunk = Object.getOwnPropertyDescriptor(
    globalThis,
    "EncodedVideoChunk",
  );
  const started = Promise.withResolvers<void>();
  const outputs: number[] = [];
  class Frame {
    readonly colorSpace = { primaries: null, transfer: null };
    constructor(readonly timestamp: number) {}
    allocationSize() {
      return 128;
    }
    clone() {
      return new Frame(this.timestamp);
    }
    close() {}
  }
  class Decoder extends EventTarget {
    state: CodecState = "unconfigured";
    decodeQueueSize = 0;
    #pending = Promise.resolve();
    constructor(readonly callbacks: VideoDecoderInit) {
      super();
    }
    configure() {
      this.state = "configured";
    }
    decode(chunk: EncodedVideoChunk) {
      this.decodeQueueSize++;
      started.resolve();
      this.#pending = this.#pending.then(async () => {
        await Bun.sleep(2);
        if (this.state === "closed") return;
        this.decodeQueueSize--;
        this.dispatchEvent(new Event("dequeue"));
        outputs.push(Math.round((chunk.timestamp * 60) / 1e6));
        this.callbacks.output(
          new Frame(chunk.timestamp) as unknown as VideoFrame,
        );
      });
    }
    flush() {
      return this.#pending;
    }
    close() {
      this.state = "closed";
    }
  }
  class Chunk {
    readonly timestamp: number;
    constructor({ timestamp }: EncodedVideoChunkInit) {
      this.timestamp = timestamp;
    }
  }
  const shown = Array.from({ length: 90 }, (_, index) => index);
  const track: VideoTrack = {
    width: 16,
    height: 16,
    rotation: 0,
    codec: "test",
    description: new Uint8Array(),
    colour: null,
    samples: shown.map((offset) => ({
      offset,
      size: 1,
      time: offset / 60,
      key: true,
    })),
    shown,
  };
  const create = SourceDecoder.forTrack(
    track,
    async () => new Uint8Array(90),
    90,
    {},
  );
  Object.assign(globalThis, {
    VideoDecoder: Decoder,
    EncodedVideoChunk: Chunk,
  });
  const decoder = create();
  try {
    decoder.prefetch(0, 12);
    await started.promise;
    const frame = await decoder.frame(50, true);
    try {
      expect(frame.timestamp).toBe(833333);
      expect(outputs.slice(0, outputs.indexOf(50))).toEqual([0, 1, 2, 3]);
    } finally {
      frame.close();
    }
  } finally {
    decoder.close();
    if (nativeDecoder)
      Object.defineProperty(globalThis, "VideoDecoder", nativeDecoder);
    else Reflect.deleteProperty(globalThis, "VideoDecoder");
    if (nativeChunk)
      Object.defineProperty(globalThis, "EncodedVideoChunk", nativeChunk);
    else Reflect.deleteProperty(globalThis, "EncodedVideoChunk");
  }
});
