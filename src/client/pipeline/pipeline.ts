import { PipelineResponseSchema } from "../../shared/pipeline";
import type { PipelinePlan } from "../../shared/pipeline";
import type { TimelineView } from "../../shared/timeline/schema";
import { useTimeline } from "../edit/timeline";
import { useTransport } from "../edit/transport";
import { createCompositor } from "./compositor";
import type { Layer } from "./compositor";
import { SourceDecoder } from "./decoder";
import { openRanges, readVideoTrack } from "./mp4";
import { appearances, visibleAt } from "./layers";
import type { Appearance, Shown } from "./layers";
import { sourceCache } from "./sources";
import { usePipeline } from "./setting";
import { chromeColourGuess } from "../../shared/videoColour";

type Plan = Exclude<PipelinePlan, { reason: string }>;

interface Source {
  /**
   * Two decoders of the file: one follows the playhead while the other decodes the opening of
   * the next clip that plays this file, so a cut within one file never waits for a keyframe.
   */
  lanes: [SourceDecoder, SourceDecoder];
  /** The lane drawn from last. */
  playing: SourceDecoder;
  /** The all-intra scrub proxy, whose frame N is the source's frame N, once it exists. */
  proxy: SourceDecoder | null;
  askProxy: () => Promise<void> | null;
  intrinsic: { width: number; height: number };
}

/**
 * The lane drawn from last when it has the frame or is on its way, else the other lane. A jump
 * goes to the other lane too, so the frames just drawn stay for an undo or a jump back.
 */
const laneFor = (source: Source, index: number) => {
  const other = source.lanes.find((lane) => lane !== source.playing)!;
  return (
    [source.playing, other].find(
      (lane) => lane.has(index) || lane.reaches(index),
    ) ?? other
  );
};

/** Playing, frames of lookahead before a clip comes into view, and its opening frames. */
const LOOKAHEAD = 45;
const OPENING = 12;
/** At rest, how far ahead the next clip to come into view is prepared: an edit often shows it. */
const NEXT = 300;
const PREPARED = 3;

const mediaUrl = (projectId: string, path: string) =>
  `/api/cutroom/projects/${encodeURIComponent(projectId)}/media/source?path=${encodeURIComponent(path)}`;

/** The colours Chrome draws a `<video>` with: its tags, and its guess for those it lacks. */
function colourOf(
  track: Awaited<ReturnType<typeof readVideoTrack>>,
): VideoColorSpaceInit {
  const guess = chromeColourGuess(
    track.height,
    track.codec.startsWith("avc") ? "h264" : "hevc",
  );
  const primaries = guess === "bt709" ? "bt709" : "smpte170m";
  return {
    primaries: track.colour?.primaries ?? primaries,
    transfer:
      track.colour?.transfer ?? (guess === "bt709" ? "bt709" : "smpte170m"),
    matrix: track.colour?.matrix ?? (guess === "bt709" ? "bt709" : "smpte170m"),
    fullRange: track.colour?.fullRange ?? false,
  };
}

async function openSource(
  url: string,
  signal: AbortSignal,
): Promise<{ decoder: SourceDecoder; intrinsic: Source["intrinsic"] }> {
  const { read, size } = await openRanges(url, signal);
  const track = await readVideoTrack(read, size);
  if (!(await SourceDecoder.supported(track)))
    throw new Error(`This browser cannot decode ${track.codec}.`);
  return {
    decoder: new SourceDecoder(track, read, size, colourOf(track)),
    intrinsic: { width: track.width, height: track.height },
  };
}

/** Attaches the pipeline to its canvas for one project; returns the teardown. */
export function attachPipeline(projectId: string, canvas: HTMLCanvasElement) {
  const closing = new AbortController();
  let compositor = createCompositor(canvas);
  // A GPU under memory pressure can drop the context; HyperFrames draws until it comes back.
  canvas.addEventListener(
    "webglcontextlost",
    (event) => {
      event.preventDefault();
      stop("the GPU dropped its drawing context");
    },
    { signal: closing.signal },
  );
  canvas.addEventListener(
    "webglcontextrestored",
    () => {
      compositor = createCompositor(canvas);
      void draw();
    },
    { signal: closing.signal },
  );
  let plan: Plan | null = null;
  let stopped: string | null = null;
  const stop = (reason: string) => {
    // Why the composition stays with HyperFrames, for whoever tries the setting, said once.
    if (!closing.signal.aborted && stopped !== reason)
      console.info(`[pipeline] off: ${reason}`);
    stopped = reason;
    usePipeline.setState({ active: false });
  };

  const sources = sourceCache(async (path): Promise<Source> => {
    const url = mediaUrl(projectId, path);
    const [{ decoder, intrinsic }, second] = await Promise.all([
      openSource(url, closing.signal),
      openSource(url, closing.signal),
    ]);
    const proxyUrl = `/api/cutroom/projects/${encodeURIComponent(projectId)}/media/scrub?path=${encodeURIComponent(path)}`;
    let askedAt = -Infinity;
    let asking: Promise<void> | null = null;
    const found: Source = {
      lanes: [decoder, second.decoder],
      playing: decoder,
      proxy: null,
      intrinsic,
      // A proxy still being made answers 202. Moving seeks use the source until it exists, and
      // a draw that wants it asks again, at most every two seconds.
      askProxy: () => {
        if (found.proxy || asking || performance.now() - askedAt < 2000)
          return asking;
        askedAt = performance.now();
        asking = openSource(proxyUrl, closing.signal)
          .then(({ decoder }) => {
            if (closing.signal.aborted) decoder.close();
            else found.proxy = decoder;
          })
          .catch(() => {})
          .finally(() => (asking = null));
        return asking;
      },
    };
    await found.askProxy();
    return found;
  });
  const source = sources.get;

  let drawing = false;
  let wanted = false;
  /** Draws the playhead's frame; a newer request while drawing replaces the one waiting. */
  const draw = async () => {
    wanted = true;
    if (drawing) return;
    drawing = true;
    try {
      while (wanted && !closing.signal.aborted) {
        wanted = false;
        await drawFrame();
      }
    } catch (error) {
      if (!closing.signal.aborted)
        stop(error instanceof Error ? error.message : String(error));
    } finally {
      drawing = false;
    }
  };

  const placed = (
    layer: Shown,
    frame: VideoFrame,
    intrinsic: Source["intrinsic"],
  ): Layer => {
    const { clip } = layer;
    return {
      frame,
      intrinsic,
      fit: layer.fit,
      x: clip.x ?? 0,
      y: clip.y ?? 0,
      scaleX: clip.scaleX ?? 1,
      scaleY: clip.scaleY ?? 1,
      rotation: clip.rotation ?? 0,
      crop: clip.crop ?? { top: 0, right: 0, bottom: 0, left: 0 },
      opacity: layer.opacity,
      brightness: layer.brightness,
    };
  };

  const drawFrame = async () => {
    const view = useTimeline.getState().view;
    const { frame, state } = useTransport.getState();
    if (!plan || !view || view.composition !== "index.html") return;
    const shown = visibleAt(view.timeline, plan, frame);
    if (!shown) return stop("a clip at the playhead is not one it can draw");
    const moving = state.kind === "scrubbing" || state.kind === "shuttle";
    const playing = state.kind === "playing";
    const pictures = await Promise.all(
      shown.map(async (layer) => {
        const found = await source(layer.clip.src!);
        if (!found.proxy) void found.askProxy();
        const index = found.playing.indexAt(layer.time);
        const lane = laneFor(found, index);
        const stand = moving ? found.proxy : null;
        return {
          layer,
          found,
          index,
          lane,
          // A frame its lane must decode from a keyframe, at rest, when the proxy has it.
          cold:
            !moving &&
            !playing &&
            !!found.proxy &&
            !lane.has(index) &&
            !lane.reaches(index),
          // Moving seeks draw the proxy, whose frame N is the source's frame N.
          request: (stand ?? lane).frame(index, playing),
        };
      }),
    );
    const paint = async (frames: VideoFrame[], standIn: boolean) => {
      // A page that paints nothing shows the browser's white canvas, as frame capture does.
      if (compositor.lost()) return;
      await compositor.draw(
        pictures.map(({ layer, found }, at) =>
          placed(layer, frames[at]!, found.intrinsic),
        ),
        plan!.background ?? "#ffffff",
        plan!.width,
        plan!.height,
      );
      canvas.dataset.standin = String(standIn);
      canvas.dataset.frame = String(frame);
      stopped = null;
      if (!usePipeline.getState().active)
        usePipeline.setState({ active: true });
    };
    const settle = async (requests: Promise<VideoFrame>[]) => {
      const frames = await Promise.allSettled(requests);
      const held = frames.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const failed = frames.find((result) => result.status === "rejected");
      if (failed) {
        for (const picture of held) picture.close();
        throw failed.reason;
      }
      return held;
    };
    if (pictures.some(({ cold }) => cold)) {
      // An edit or a jump at rest: the proxy's frame now, the exact one once it has decoded.
      // A proxy that fails only costs the stand-in; the exact frames still draw.
      const standIns = await settle(
        pictures.map(({ cold, found, index }, at) =>
          cold
            ? found.proxy!.frame(index)
            : pictures[at]!.request.then((frame) => frame.clone()),
        ),
      ).catch(() => []);
      try {
        if (standIns.length && !wanted) await paint(standIns, true);
      } finally {
        for (const picture of standIns) picture.close();
      }
    }
    const frames = await settle(pictures.map(({ request }) => request));
    try {
      if (pictures.some(({ cold }) => cold) && wanted) return;
      await paint(frames, false);
    } finally {
      for (const picture of frames) picture.close();
    }
    for (const { found, lane, index } of pictures) {
      if (moving) continue;
      found.playing = lane;
      if (playing) lane.prefetch(index + 1, index + 8);
    }
    if (playing) prepare(view, frame, LOOKAHEAD, OPENING);
    else if (!moving) prepare(view, frame, NEXT, PREPARED);
  };

  let upcoming: {
    view: TimelineView;
    plan: Plan;
    from: number;
    to: number;
    list: Appearance[];
  } | null = null;
  /**
   * Decodes the openings of clips that come into view within `span` frames, whether they start
   * or what covered them ends, on the lane the playhead is not on.
   */
  const prepare = (
    view: TimelineView,
    frame: number,
    span: number,
    count: number,
  ) => {
    if (!plan) return;
    if (
      upcoming?.view !== view ||
      upcoming.plan !== plan ||
      frame < upcoming.from ||
      frame + span > upcoming.to
    ) {
      const to = frame + Math.max(span, NEXT);
      upcoming = {
        view,
        plan,
        from: frame,
        to,
        list: appearances(view.timeline, plan, frame, to),
      };
    }
    const sources = new Set<string>();
    for (const { frame: at, layer } of upcoming.list) {
      if (at <= frame || at > frame + span) continue;
      const src = layer.clip.src!;
      // At rest, only the next opening of each file: the spare lane holds one.
      if (count === PREPARED && sources.has(src)) continue;
      sources.add(src);
      void source(src)
        .then((found) => {
          const index = found.playing.indexAt(layer.time);
          // The playing lane may hold it now, but drops it as the playhead moves on.
          const spare = found.lanes.find((lane) => lane !== found.playing)!;
          if (!spare.has(index) && !spare.reaches(index))
            spare.prefetch(index, index + count - 1);
        })
        .catch(() => {});
    }
  };

  const readPlan = async () => {
    const view = useTimeline.getState().view;
    // The timeline's first read starts the plan's.
    if (!view) return;
    if (view.composition !== "index.html") {
      plan = null;
      return stop("only the entry composition plays through it");
    }
    const response = await fetch(
      `/api/cutroom/projects/${encodeURIComponent(projectId)}/pipeline`,
      { signal: closing.signal },
    );
    const { plan: next } = PipelineResponseSchema.parse(await response.json());
    if ("reason" in next) {
      plan = null;
      return stop(next.reason);
    }
    plan = next;
    sources.forgetFailures();
    // Open every file now: opening one mid-playback costs the clock a few frames.
    for (const clip of view.timeline.clips)
      if (clip.src && next.drawable[clip.id])
        void source(clip.src).catch(() => {});
    void draw();
  };
  const refresh = () =>
    readPlan().catch((error: unknown) => {
      if (!closing.signal.aborted)
        stop(error instanceof Error ? error.message : String(error));
    });
  void refresh();

  const unsubscribe = [
    useTransport.subscribe((state, previous) => {
      if (state.frame !== previous.frame || state.state !== previous.state)
        void draw();
    }),
    useTimeline.subscribe((state, previous) => {
      if (state.view === previous.view) return;
      // The shown view already holds the edit: draw it now, and let the server's plan follow.
      void draw();
      if (state.view?.revision !== previous.view?.revision) void refresh();
    }),
  ];
  return () => {
    closing.abort();
    for (const stop of unsubscribe) stop();
    usePipeline.setState({ active: false });
    for (const found of sources.values())
      void found.then(({ lanes, proxy }) => {
        for (const lane of lanes) lane.close();
        proxy?.close();
      });
    compositor.dispose();
  };
}
