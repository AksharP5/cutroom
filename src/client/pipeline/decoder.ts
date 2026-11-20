import { presentationTimeTolerance } from "../../shared/frames";
import { LIMITS } from "./mp4";
import type { ReadRange, VideoTrack } from "./mp4";

const BLOCK = 1 << 20;
/** Media bytes kept per source: a few seconds of camera footage either side of the playhead. */
const BLOCKS = 12;

/** Reads samples through 1 MiB blocks, so a GOP costs a request or two instead of one per frame. */
function blockReader(read: ReadRange, size: number) {
  const blocks = new Map<number, Promise<Uint8Array>>();
  let last = -1;
  const fetchBlock = (index: number) => {
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
  const block = (index: number) => {
    const found = fetchBlock(index);
    // Reading on through a file, as playback does, starts the next block before it is needed.
    if (
      index === last + 1 &&
      (index + 1) * BLOCK < size &&
      !blocks.has(index + 1)
    )
      void fetchBlock(index + 1).catch(() => {});
    last = index;
    return found;
  };
  return async (offset: number, length: number) => {
    // The demuxer bounds samples by the file; this keeps a bad one from allocating anyway.
    if (length > LIMITS.sample || offset + length > size)
      throw new Error("A sample lies outside the file.");
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
  limit: 128 << 20,
  used: 0,
};
/** Samples a run may feed past a frame that has not come out before it gives up on it. */
const PAST = 32;
/** Frames each decoder keeps: enough for a GOP's worth of reverse steps or a cut's opening. */
const KEPT = 24;
/** Gamuts and transfers that need Chrome's tone mapping, which a bitstream may name with no `colr`. */
const WIDE = new Set<string | null>(["bt2020", "smpte432", "pq", "hlg"]);

/**
 * One WebCodecs decoder for one file, however many clips play it. Frames are found by their
 * presentation index; a request decodes forward from where the decoder is when the frame lies
 * ahead in the same GOP, and otherwise from the keyframe that supplies its references.
 */
export class SourceDecoder {
  readonly #track: VideoTrack;
  readonly #sample: (offset: number, length: number) => Promise<Uint8Array>;
  readonly #config: VideoDecoderConfig;
  readonly #keep: number;
  #decoder: VideoDecoder | null = null;
  /** Decode-order index of the next sample to send, or -1 when the next must be a keyframe. */
  #next = -1;
  /** The keyframe the current run of samples started from. */
  #runStart = -1;
  /** Leading pictures can lack references only in the first GOP of a discontinuous run. */
  #openingGop = false;
  /** Where the decoder is wanted: the last frame drawn, or the start of its latest prefetch. */
  #asked = 0;
  /** The last frame drawn, which eviction keeps: an undo or a step back shows it again. */
  #drawn = -1;
  /** The frame the running request decodes towards, in a sequential run, or -1. */
  #heading = -1;
  /** The range a queued prefetch will decode, which later prefetches widen instead of queueing. */
  #ahead: { from: number; to: number } | null = null;
  /** Frames the current run has put out, so a sent frame is known to be in flight or gone. */
  readonly #produced = new Set<number>();
  readonly #frames = new Map<number, VideoFrame>();
  readonly #indexOf: ReadonlyMap<number, number>;
  /** Requests waiting for a frame; each gets its own reference, which eviction cannot close. */
  readonly #waiting = new Map<number, Set<(frame: VideoFrame) => void>>();
  #queue: Promise<unknown> = Promise.resolve();
  #error: Error | null = null;
  /** Set for good once a frame shows the file is one the pipeline must not draw. */
  #refused: Error | null = null;
  /**
   * Frames the decoder never puts out from any keyframe, such as a B-frame of DaVinci Resolve's
   * that refers to a picture before the file's first. A paused <video> keeps showing the frame
   * before, and so does the pipeline.
   */
  readonly #missing = new Set<number>();
  /** A decoded picture's size, which 10-bit footage doubles. */
  #frameBytes = 0;
  readonly #closing = new AbortController();

  private constructor(
    track: VideoTrack,
    sample: ReturnType<typeof blockReader>,
    indexOf: ReadonlyMap<number, number>,
    colour: VideoColorSpaceInit,
    shortWindow: "scrub" | "audition" | false,
  ) {
    this.#track = track;
    // Scrubbing can decode its keyframes again. A warmed take follows only the current window.
    this.#keep =
      shortWindow === "scrub" ? 4 : shortWindow === "audition" ? 8 : KEPT;
    this.#sample = sample;
    this.#indexOf = indexOf;
    this.#config = {
      codec: track.codec,
      description: track.description,
      codedWidth: track.width,
      codedHeight: track.height,
      colorSpace: colour,
      // The editor's <video> decodes in software on Linux; matching it keeps colours identical.
      hardwareAcceleration: "prefer-software",
      // Frame threading, as the editor's <video> decodes: low-latency decoding kept up with 4K60
      // only 1.5 times over, and playback fell behind it to 2 pictures a second.
      optimizeForLatency: Boolean(shortWindow),
    };
  }

  /** Independent decoder runs over one sample index and one cache of compressed bytes. */
  static forTrack(
    track: VideoTrack,
    read: ReadRange,
    size: number,
    colour: VideoColorSpaceInit,
  ) {
    const sample = blockReader(read, size);
    const indexOf = new Map<number, number>();
    for (const [index, sampleIndex] of track.shown.entries())
      indexOf.set(Math.round(track.samples[sampleIndex]!.time * 1e6), index);
    return (window: "scrub" | "audition" | false = false) =>
      new SourceDecoder(track, sample, indexOf, colour, window);
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
    const { primaries, transfer } = frame.colorSpace;
    if (WIDE.has(primaries) || WIDE.has(transfer)) {
      frame.close();
      this.#refused = this.#error = new Error(
        "Wide-gamut and HDR video stays with HyperFrames.",
      );
      return;
    }
    const index = this.#indexOf.get(frame.timestamp);
    if (
      index === undefined ||
      this.#closing.signal.aborted ||
      this.#frames.has(index)
    ) {
      frame.close();
      return;
    }
    this.#produced.add(index);
    this.#frames.set(index, frame);
    this.#frameBytes = frame.allocationSize();
    frameBudget.used += this.#frameBytes;
    while (this.#frames.size > this.#keep && this.evictOldest(frame));
    evict(this, frame);
    for (const wake of this.#waiting.get(index) ?? []) wake(frame.clone());
    this.#waiting.delete(index);
  }

  /**
   * How many of `count` frames a prefetch may decode: what a third of the shared budget holds at
   * this file's frame size, so the playhead's frames, the next clip's opening and another file's
   * fit together instead of evicting each other. Twelve 8-bit 1080p frames take 36 MiB.
   */
  room(count: number) {
    const { width, height } = this.#track;
    const bytes = this.#frameBytes || width * height * 1.5;
    return Math.max(
      2,
      Math.min(count, Math.floor(frameBudget.limit / 3 / bytes)),
    );
  }

  /** Clockwise degrees the file shows its stored pictures turned by. */
  get rotation() {
    return this.#track.rotation;
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
      if (samples[shown[middle]!]!.time <= time + presentationTimeTolerance)
        low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** A clone of the frame to draw, which the caller closes. */
  frame(index: number, sequential = false): Promise<VideoFrame> {
    if (this.#refused) return Promise.reject(this.#refused);
    while (this.#missing.has(index)) index--;
    this.#drawn = index;
    this.#asked = index;
    const cached = this.#touch(index);
    if (cached) return Promise.resolve(cached.clone());
    // A run on its way to a later frame puts this one out first: wait for it there rather than
    // behind the work queued after it.
    if (this.#heading >= index && this.reaches(index)) {
      const arrived = this.#arrival(index);
      if (arrived) return arrived;
    }
    return this.#enqueue(index, sequential);
  }

  #enqueue(index: number, sequential: boolean) {
    const run = this.#queue.then(() => this.#decode(index, sequential));
    this.#queue = run.catch(() => {});
    return run;
  }

  /** The frame as the current run puts it out, or null when the run ends without it. */
  #arrival(index: number): Promise<VideoFrame> | null {
    const running = this.#queue;
    return new Promise<VideoFrame>((resolve, reject) => {
      const waiters = this.#waiting.get(index) ?? new Set();
      const wake = (frame: VideoFrame) => {
        waiters.delete(wake);
        resolve(frame);
      };
      waiters.add(wake);
      this.#waiting.set(index, waiters);
      // Should the run stop short of it, decode it in turn.
      void running.then(() => {
        if (!waiters.delete(wake)) return;
        const cached = this.#touch(index);
        if (cached) resolve(cached.clone());
        else this.#enqueue(index, true).then(resolve, reject);
      });
    });
  }

  has(index: number) {
    return this.#frames.has(index);
  }

  #keyFor(target: number, preroll = false) {
    const { samples } = this.#track;
    let key = target;
    while (key > 0 && !samples[key]!.key) key--;
    // An open GOP can store a B-frame after its keyframe that presents before it.
    // That leading picture can reference the previous GOP.
    if (key > 0 && (preroll || samples[target]!.time < samples[key]!.time)) {
      do key--;
      while (key > 0 && !samples[key]!.key);
    }
    return key;
  }

  /** Whether this decoder reaches the frame without starting again from a keyframe. */
  reaches(index: number) {
    const target = this.#track.shown[index];
    if (target === undefined || this.#runStart < 0) return false;
    const key = this.#keyFor(target);
    // Sent and still in flight, or ahead in a run that has reached its GOP.
    if (this.#runStart > key) return false;
    return target < this.#next ? !this.#produced.has(index) : key <= this.#next;
  }

  #restart(key: number) {
    this.#next = key;
    this.#runStart = key;
    this.#openingGop = key > 0;
    this.#heading = -1;
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
    if (this.#closing.signal.aborted)
      throw new Error("The decoder was closed.");
    if (this.#refused) throw this.#refused;
    while (this.#missing.has(index)) index--;
    const cached = this.#touch(index);
    if (cached) return cached.clone();
    if (!this.#decoder || this.#error || this.#decoder.state === "closed") {
      this.#error = null;
      this.#decoder = this.#create();
      this.#restart(-1);
    }
    const decoder = this.#decoder;
    const { samples, shown } = this.#track;
    const target = shown[index]!;
    // A file can still require preroll for a picture that presents after its keyframe.
    const key = this.#keyFor(target, retried);
    let gopEnd = target + 1;
    while (gopEnd < samples.length && !samples[gopEnd]!.key) gopEnd++;
    if (sequential) this.#heading = Math.max(this.#heading, index);
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
        if (sample.key && this.#next > this.#runStart) this.#openingGop = false;
        // A discontinuous run lacks references for its opening GOP's leading pictures.
        // Submitting them can return pixels from the old GOP under the new timestamp.
        if (
          this.#openingGop &&
          !sample.key &&
          sample.time < samples[this.#runStart]!.time
        ) {
          this.#next++;
          continue;
        }
        const data = await this.#sample(sample.offset, sample.size);
        if (this.#closing.signal.aborted)
          throw new Error("The decoder was closed.");
        decoder.decode(
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
      await decoder.flush();
      // A flush ends the run even if the next sample is already a keyframe.
      this.#restart(
        this.#next === gopEnd && gopEnd < samples.length ? gopEnd : -1,
      );
    };
    if (sequential) {
      // Playback: frame threading holds a few frames, so keep feeding until it lands, on into
      // the next GOP, which starts with its own keyframe. Only the file's end needs a flush.
      while (!landed() && !this.#frames.has(index) && !this.#error) {
        // Long past the frame without it: it was dropped, so decode it again from its keyframe.
        if (this.#next >= samples.length || this.#next > target + PAST) {
          await flush();
          break;
        }
        await send(Math.min(samples.length, Math.max(this.#next, target) + 4));
        await Promise.race([arrived, this.#drained(decoder)]);
      }
    } else {
      // A seek wants this one frame as soon as possible: send up to it and flush it out.
      await send(target + 1);
      await Promise.race([arrived, this.#drained(decoder)]);
      if (!landed() && !this.#frames.has(index)) await flush();
    }
    this.#waiting.get(index)?.delete(wake);
    if (got) return got;
    if (this.#error) throw this.#error;
    const frame = this.#touch(index);
    if (frame) return frame.clone();
    if (retried) {
      if (index === 0)
        throw new Error("The decoder did not produce the frame.");
      this.#missing.add(index);
      return this.#decode(index - 1, false);
    }
    // Decoded and dropped again before it was drawn: decode it once more on its own.
    this.#restart(-1);
    return this.#decode(index, false, true);
  }

  /** Resolves once every sample sent has decoded and its output had a moment to arrive. */
  async #drained(decoder: VideoDecoder) {
    const { signal } = this.#closing;
    while (
      !signal.aborted &&
      decoder.decodeQueueSize > 0 &&
      decoder.state === "configured"
    )
      await new Promise<void>((resolve) => {
        const done = () => {
          decoder.removeEventListener("dequeue", done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        decoder.addEventListener("dequeue", done, { once: true });
        signal.addEventListener("abort", done, { once: true });
      });
    await new Promise((resolve) => setTimeout(resolve, 4));
  }

  /**
   * Decodes `from` through `to` ahead of the clock, so the frames are ready when it reaches them.
   * A prefetch still waiting to start takes the new range instead, so they never pile up.
   */
  prefetch(from: number, to = from) {
    from = Math.max(0, from);
    to = Math.min(to, this.frameCount - 1);
    if (from > to) return;
    if (this.#ahead) {
      this.#ahead = { from, to };
      return;
    }
    this.#ahead = { from, to };
    const run = this.#queue.then(async () => {
      const { from, to } = this.#ahead!;
      this.#ahead = null;
      this.#asked = from;
      for (
        let index = from;
        index <= to && !this.#closing.signal.aborted;
        index++
      )
        if (!this.#frames.has(index)) (await this.#decode(index, true)).close();
    });
    this.#queue = run.catch(() => {});
  }

  /**
   * Releases the cached frame furthest from the last one asked for, other than `keep`. Frames
   * behind it go first, since playback and steps mostly move forward. False when none is left.
   */
  evictOldest(keep: VideoFrame, preserveDrawn = true) {
    let victim: number | undefined;
    let distance = -1;
    for (const [index, frame] of this.#frames) {
      if (frame === keep || (preserveDrawn && index === this.#drawn)) continue;
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
    this.#closing.abort();
    for (const frame of this.#frames.values()) {
      frameBudget.used -= frame.allocationSize();
      frame.close();
    }
    this.#frames.clear();
    sources.delete(this);
    if (this.#decoder && this.#decoder.state !== "closed")
      this.#decoder.close();
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
  if (frameBudget.used <= frameBudget.limit) return;
  const order = [...sources].sort(
    (a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0),
  );
  for (const victim of order)
    while (frameBudget.used > frameBudget.limit && victim.evictOldest(keep));
  // One last picture per lane can exceed the budget on projects with many
  // files. Keep those pictures only while there is room for them.
  for (const victim of order) {
    if (frameBudget.used <= frameBudget.limit) break;
    victim.evictOldest(keep, false);
  }
}
