import type { ReadRange, VideoTrack } from "./mp4";

const BLOCK = 1 << 20;
/** Media bytes kept per source: a few seconds of camera footage either side of the playhead. */
const BLOCKS = 12;

/** Reads samples through 1 MiB blocks, so a GOP costs a request or two instead of one per frame. */
function blockReader(read: ReadRange, size: number) {
  const blocks = new Map<number, Promise<Uint8Array>>();
  const block = (index: number) => {
    let found = blocks.get(index);
    if (found) blocks.delete(index);
    else {
      found = read(index * BLOCK, Math.min(size, (index + 1) * BLOCK));
      found.catch(() => blocks.delete(index));
    }
    blocks.set(index, found);
    while (blocks.size > BLOCKS) blocks.delete(blocks.keys().next().value!);
    return found;
  };
  return async (offset: number, length: number) => {
    const first = Math.floor(offset / BLOCK);
    const last = Math.floor((offset + length - 1) / BLOCK);
    if (first === last) {
      const bytes = await block(first);
      return bytes.subarray(
        offset - first * BLOCK,
        offset - first * BLOCK + length,
      );
    }
    const out = new Uint8Array(length);
    for (let index = first; index <= last; index++) {
      const bytes = await block(index);
      const from = Math.max(offset, index * BLOCK);
      const to = Math.min(offset + length, (index + 1) * BLOCK);
      out.set(
        bytes.subarray(from - index * BLOCK, to - index * BLOCK),
        from - offset,
      );
    }
    return out;
  };
}

/** Decoded frames shared by every source, oldest drawn closed first. */
export const frameBudget = {
  /** Bytes of decoded pictures held, across sources. */
  limit: 192 << 20,
  used: 0,
};
/** Frames each decoder keeps: enough for a GOP's worth of reverse steps or a cut's opening. */
const KEPT = 24;

/**
 * One WebCodecs decoder for one file, however many clips play it. Frames are found by their
 * presentation index; a request decodes forward from where the decoder is when the frame lies
 * ahead in the same GOP, and otherwise from the GOP's keyframe.
 */
export class SourceDecoder {
  readonly #track: VideoTrack;
  readonly #sample: (offset: number, length: number) => Promise<Uint8Array>;
  readonly #config: VideoDecoderConfig;
  #decoder: VideoDecoder;
  /** Decode-order index of the next sample to send, or -1 when the next must be a keyframe. */
  #next = -1;
  /** The keyframe the current run of samples started from. */
  #runStart = -1;
  /** The last frame asked for, which eviction keeps close to. */
  #asked = 0;
  /** Frames the current run has put out, so a sent frame is known to be in flight or gone. */
  readonly #produced = new Set<number>();
  readonly #frames = new Map<number, VideoFrame>();
  readonly #indexOf = new Map<number, number>();
  /** Requests waiting for a frame; each gets its own reference, which eviction cannot close. */
  readonly #waiting = new Map<number, Set<(frame: VideoFrame) => void>>();
  #queue: Promise<unknown> = Promise.resolve();
  #error: Error | null = null;
  #closed = false;

  constructor(
    track: VideoTrack,
    read: ReadRange,
    size: number,
    colour: VideoColorSpaceInit,
  ) {
    this.#track = track;
    this.#sample = blockReader(read, size);
    for (const [index, sample] of track.shown.entries())
      this.#indexOf.set(Math.round(track.samples[sample]!.time * 1e6), index);
    this.#config = {
      codec: track.codec,
      description: track.description,
      codedWidth: track.width,
      codedHeight: track.height,
      colorSpace: colour,
      // The editor's <video> decodes in software on Linux; matching it keeps colours identical.
      hardwareAcceleration: "prefer-software",
      optimizeForLatency: true,
    };
    this.#decoder = this.#create();
  }

  static supported(track: VideoTrack) {
    return VideoDecoder.isConfigSupported({
      codec: track.codec,
      description: track.description,
      codedWidth: track.width,
      codedHeight: track.height,
      hardwareAcceleration: "prefer-software",
    }).then((support) => support.supported === true);
  }

  #create() {
    const decoder = new VideoDecoder({
      output: (frame) => this.#output(frame),
      error: (error) => {
        this.#error = error instanceof Error ? error : new Error(String(error));
        this.#next = -1;
      },
    });
    decoder.configure(this.#config);
    return decoder;
  }

  #output(frame: VideoFrame) {
    const index = this.#indexOf.get(frame.timestamp);
    if (index === undefined || this.#closed || this.#frames.has(index)) {
      frame.close();
      return;
    }
    this.#produced.add(index);
    this.#frames.set(index, frame);
    frameBudget.used += frame.allocationSize();
    while (this.#frames.size > KEPT && this.evictOldest(frame));
    evict(this, frame);
    for (const wake of this.#waiting.get(index) ?? []) wake(frame.clone());
    this.#waiting.delete(index);
  }

  get frameCount() {
    return this.#track.shown.length;
  }

  /** The presentation index shown at a media time, as a paused `<video>` shows it. */
  indexAt(time: number) {
    const { shown, samples } = this.#track;
    let low = 0;
    let high = shown.length - 1;
    if (time < samples[shown[0]!]!.time) return 0;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (samples[shown[middle]!]!.time <= time + 1e-6) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** A clone of the decoded frame, which the caller closes. */
  frame(index: number, sequential = false): Promise<VideoFrame> {
    const cached = this.#touch(index);
    if (cached) return Promise.resolve(cached.clone());
    const run = this.#queue.then(() => this.#decode(index, sequential));
    this.#queue = run.catch(() => {});
    return run;
  }

  has(index: number) {
    return this.#frames.has(index);
  }

  /** Whether this decoder reaches the frame without starting again from a keyframe. */
  reaches(index: number) {
    const { samples, shown } = this.#track;
    const target = shown[index];
    if (target === undefined || this.#runStart < 0) return false;
    let key = target;
    while (key > 0 && !samples[key]!.key) key--;
    // Sent and still in flight, or ahead in a run that has reached its GOP.
    return target < this.#next
      ? this.#runStart <= target && !this.#produced.has(index)
      : key <= this.#next;
  }

  #restart(key: number) {
    this.#next = key;
    this.#runStart = key;
    this.#produced.clear();
  }

  #touch(index: number) {
    const frame = this.#frames.get(index);
    if (!frame) return null;
    // Map order is recency: the oldest drawn frame is evicted first.
    this.#frames.delete(index);
    this.#frames.set(index, frame);
    lastUsed.set(this, performance.now());
    return frame;
  }

  async #decode(
    index: number,
    sequential: boolean,
    retried = false,
  ): Promise<VideoFrame> {
    if (this.#closed) throw new Error("The decoder was closed.");
    if (!sequential || index > this.#asked) this.#asked = index;
    const cached = this.#touch(index);
    if (cached) return cached.clone();
    if (this.#error || this.#decoder.state === "closed") {
      this.#error = null;
      this.#decoder = this.#create();
      this.#restart(-1);
    }
    const { samples, shown } = this.#track;
    const target = shown[index]!;
    let key = target;
    while (key > 0 && !samples[key]!.key) key--;
    let gopEnd = target + 1;
    while (gopEnd < samples.length && !samples[gopEnd]!.key) gopEnd++;
    // A sample in flight comes out on its own; one ahead in the same run is fed forward.
    // Anything else starts at its keyframe, which the decoder takes at any point.
    if (!this.reaches(index)) this.#restart(key);
    let got: VideoFrame | null = null;
    let wake!: (frame: VideoFrame) => void;
    const arrived = new Promise<void>((resolve) => {
      wake = (frame) => {
        if (got) frame.close();
        else got = frame;
        resolve();
      };
    });
    const waiters = this.#waiting.get(index) ?? new Set();
    waiters.add(wake);
    this.#waiting.set(index, waiters);
    const landed = () => got !== null;
    const send = async (until: number) => {
      while (this.#next < until) {
        const sample = samples[this.#next]!;
        const data = await this.#sample(sample.offset, sample.size);
        if (this.#closed) throw new Error("The decoder was closed.");
        this.#decoder.decode(
          new EncodedVideoChunk({
            type: sample.key ? "key" : "delta",
            timestamp: Math.round(sample.time * 1e6),
            data,
          }),
        );
        this.#next++;
      }
    };
    const flush = async () => {
      await this.#decoder.flush();
      // After a flush the decoder takes only a keyframe, which a GOP's end already is.
      if (this.#next !== gopEnd || gopEnd >= samples.length) this.#restart(-1);
    };
    if (sequential) {
      // Playback: frame threading holds a few frames, so keep feeding the GOP until it lands.
      while (!landed() && !this.#frames.has(index) && !this.#error) {
        if (this.#next >= gopEnd) {
          await flush();
          break;
        }
        await send(Math.min(gopEnd, Math.max(this.#next, target) + 4));
        await Promise.race([arrived, this.#drained()]);
      }
    } else {
      // A seek wants this one frame as soon as possible: send up to it and flush it out.
      await send(target + 1);
      await Promise.race([arrived, this.#drained()]);
      if (!landed() && !this.#frames.has(index)) await flush();
    }
    this.#waiting.get(index)?.delete(wake);
    if (got) return got;
    if (this.#error) throw this.#error;
    const frame = this.#touch(index);
    if (frame) return frame.clone();
    if (retried) throw new Error("The decoder did not produce the frame.");
    // Decoded and dropped again before it was drawn: decode it once more on its own.
    this.#restart(-1);
    return this.#decode(index, false, true);
  }

  /** Resolves once every sample sent has decoded and its output had a moment to arrive. */
  async #drained() {
    const decoder = this.#decoder;
    while (decoder.decodeQueueSize > 0 && decoder.state === "configured")
      await new Promise((resolve) =>
        decoder.addEventListener("dequeue", resolve, { once: true }),
      );
    await new Promise((resolve) => setTimeout(resolve, 4));
  }

  /** Decodes ahead of playback, so the frame is ready when the clock reaches it. */
  prefetch(index: number) {
    if (index < 0 || index >= this.frameCount || this.#frames.has(index))
      return;
    void this.frame(index, true)
      .then((frame) => frame.close())
      .catch(() => {});
  }

  /**
   * Releases the cached frame furthest from the last one asked for, other than `keep`. Frames
   * behind it go first, since playback and steps mostly move forward. False when none is left.
   */
  evictOldest(keep: VideoFrame) {
    let victim: number | undefined;
    let distance = -1;
    for (const [index, frame] of this.#frames) {
      if (frame === keep) continue;
      const away =
        index < this.#asked ? (this.#asked - index) * 2 : index - this.#asked;
      if (away > distance) {
        distance = away;
        victim = index;
      }
    }
    if (victim === undefined) return false;
    const frame = this.#frames.get(victim)!;
    this.#frames.delete(victim);
    frameBudget.used -= frame.allocationSize();
    frame.close();
    return true;
  }

  close() {
    this.#closed = true;
    for (const frame of this.#frames.values()) {
      frameBudget.used -= frame.allocationSize();
      frame.close();
    }
    this.#frames.clear();
    sources.delete(this);
    if (this.#decoder.state !== "closed") this.#decoder.close();
  }
}

const sources = new Set<SourceDecoder>();
const lastUsed = new WeakMap<SourceDecoder, number>();
/**
 * Over budget, sources give up their oldest frames, the source drawn least recently first. The
 * frame just decoded stays: a request may be waiting for it.
 */
function evict(from: SourceDecoder, keep: VideoFrame) {
  sources.add(from);
  lastUsed.set(from, lastUsed.get(from) ?? performance.now());
  const order = [...sources].sort(
    (a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0),
  );
  for (const victim of order)
    while (frameBudget.used > frameBudget.limit && victim.evictOldest(keep));
}
