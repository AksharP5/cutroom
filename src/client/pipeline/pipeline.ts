import { PipelineResponseSchema } from "../../shared/pipeline";
import type { PipelinePlan } from "../../shared/pipeline";
import { useTimeline } from "../edit/timeline";
import { useTransport } from "../edit/transport";
import { createCompositor } from "./compositor";
import type { Layer } from "./compositor";
import { SourceDecoder } from "./decoder";
import { openRanges, readVideoTrack } from "./mp4";
import { shownAt } from "./layers";
import { sourceCache } from "./sources";
import { usePipeline } from "./setting";
import { framesBefore } from "../../shared/timeline/transition";
import { chromeColourGuess } from "../../shared/videoColour";

type Plan = Exclude<PipelinePlan, { reason: string }>;

interface Source {
  /**
   * Two decoders of the file: one follows the playhead while the other decodes the opening of
   * the next clip that plays this file, so a cut within one file never waits for a keyframe.
   */
  lanes: [SourceDecoder, SourceDecoder];
  /** The lane the playhead drew from last. */
  playing: SourceDecoder;
  /** The all-intra scrub proxy, whose frame N is the source's frame N. */
  proxy: SourceDecoder | null;
  intrinsic: { width: number; height: number };
}

/** The playing lane when it has the frame or is on its way; else the other lane if it is. */
const laneFor = (source: Source, index: number) => {
  const other = source.lanes.find((lane) => lane !== source.playing)!;
  for (const lane of [source.playing, other])
    if (lane.has(index) || lane.reaches(index)) return lane;
  return source.playing;
};

/** Frames of lookahead before a cut, and how many opening frames to decode there. */
const LOOKAHEAD = 45;
const OPENING = 12;

const mediaUrl = (projectId: string, path: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/preview/${path.split("/").map(encodeURIComponent).join("/")}`;

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
    // A proxy that is still being made answers 202; moving seeks use the source meanwhile.
    const proxy = await openSource(proxyUrl, closing.signal)
      .then(({ decoder }) => decoder)
      .catch(() => null);
    return {
      lanes: [decoder, second.decoder] as [SourceDecoder, SourceDecoder],
      playing: decoder,
      proxy,
      intrinsic,
    };
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

  const drawFrame = async () => {
    const view = useTimeline.getState().view;
    const { frame, state } = useTransport.getState();
    if (!plan || !view || view.composition !== "index.html") return;
    const all = shownAt(view.timeline, plan, frame);
    if (!all) return stop("a clip at the playhead is not one it can draw");
    // Nothing shows beneath an opaque clip that fills the frame untouched.
    const covering = all.findLastIndex(
      ({ clip, fit, opacity, brightness }) =>
        opacity === 1 &&
        brightness === 1 &&
        fit !== "contain" &&
        !clip.x &&
        !clip.y &&
        (clip.scaleX ?? 1) >= 1 &&
        (clip.scaleY ?? 1) >= 1 &&
        !clip.rotation &&
        !Object.values(clip.crop ?? {}).some(Boolean),
    );
    const shown = all.slice(Math.max(0, covering));
    const moving = state.kind === "scrubbing" || state.kind === "shuttle";
    const frames: VideoFrame[] = [];
    try {
      const layers: Layer[] = await Promise.all(
        shown.map(async (layer) => {
          const found = await source(layer.clip.src!);
          const { proxy, intrinsic } = found;
          const index = found.playing.indexAt(layer.time);
          const lane = laneFor(found, index);
          const stand = moving && proxy ? proxy : lane;
          const picture = await stand.frame(index, state.kind === "playing");
          frames.push(picture);
          if (state.kind === "playing") {
            found.playing = lane;
            for (let ahead = 1; ahead <= 8; ahead++)
              lane.prefetch(index + ahead);
          }
          const { clip } = layer;
          return {
            frame: picture,
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
        }),
      );
      // The canvas stays hidden until its first frame is drawn, so measure the picture it fills.
      const box = (canvas.parentElement ?? canvas).getBoundingClientRect();
      const width = Math.max(1, Math.round(box.width * devicePixelRatio));
      const height = Math.max(1, Math.round(box.height * devicePixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      // A page that paints nothing shows the browser's white canvas, as frame capture does.
      if (compositor.lost()) return;
      compositor.draw(
        layers,
        plan.background ?? "#ffffff",
        plan.width,
        plan.height,
      );
      if (state.kind === "playing") void lookahead(frame);
      canvas.dataset.frame = String(frame);
      stopped = null;
      if (!usePipeline.getState().active)
        usePipeline.setState({ active: true });
    } finally {
      for (const picture of frames) picture.close();
    }
  };

  /** Decodes the opening frames of clips that start soon, on the lane the playhead is not on. */
  const lookahead = async (frame: number) => {
    const view = useTimeline.getState().view;
    if (!plan || !view) return;
    const { timeline } = view;
    for (const clip of timeline.clips) {
      if (clip.kind !== "video" || !clip.src) continue;
      const first =
        clip.start - (clip.transitionIn ? framesBefore(clip.transitionIn) : 0);
      if (first <= frame || first > frame + LOOKAHEAD) continue;
      const next = shownAt(timeline, plan, first)?.find(
        (shown) => shown.clip.id === clip.id,
      );
      if (!next) continue;
      const found = await source(clip.src);
      const index = found.playing.indexAt(next.time);
      // The playing lane may hold it now, but drops it as the playhead moves on.
      const spare = found.lanes.find((lane) => lane !== found.playing)!;
      if (spare.has(index) || spare.reaches(index)) continue;
      for (let ahead = 0; ahead < OPENING; ahead++)
        spare.prefetch(index + ahead);
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
