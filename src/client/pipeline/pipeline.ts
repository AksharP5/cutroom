import { PipelineResponseSchema } from "../../shared/pipeline";
import type { PipelinePlan } from "../../shared/pipeline";
import type { TimelineView } from "../../shared/timeline/schema";
import { useGradeBypass, usePreviewGrade } from "../edit/preview";
import { previewGrades } from "./grades";
import type { GradeTexture } from "./grades";
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
import { FrameGridSchema, frameSeek } from "../../shared/frames";
import type { FrameGrid } from "../../shared/frames";

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
  /** Where export puts the file's frames, or null to show them at their own times. */
  grid: FrameGrid;
}

/** The frame a source shows at a media time: the one export writes there. */
const indexAt = (found: Source, time: number) =>
  found.playing.indexAt(found.grid ? frameSeek(found.grid, time) : time);

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
  const turned = track.rotation % 180 !== 0;
  return {
    decoder: new SourceDecoder(track, read, size, colourOf(track)),
    intrinsic: {
      width: turned ? track.height : track.width,
      height: turned ? track.width : track.height,
    },
  };
}

/** Attaches the pipeline to its canvas for one project; returns the teardown. */
export function attachPipeline(projectId: string, canvas: HTMLCanvasElement) {
  const closing = new AbortController();
  let compositor = createCompositor(canvas);
  const grades = previewGrades(projectId);
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
  const explained = new Set<string>();
  let stopped: string | null = null;
  const stop = (reason: string) => {
    // Why the composition stays with HyperFrames, for whoever tries the setting, said once.
    if (!closing.signal.aborted && stopped !== reason)
      console.info(`[pipeline] off: ${reason}`);
    stopped = reason;
    usePipeline.setState({ active: false });
  };

  /** Files whose editing proxy is being made, each asked after again until it exists. */
  const preparing = new Set<string>();
  const proxyReady = async (url: string, path: string) => {
    preparing.add(path);
    try {
      for (;;) {
        const response = await fetch(url, {
          headers: { range: "bytes=0-0" },
          signal: closing.signal,
        });
        await response.body?.cancel();
        if (response.status !== 202) break;
        await new Promise((done) => setTimeout(done, 2000));
      }
      sources.forgetFailures();
      void draw();
    } finally {
      preparing.delete(path);
    }
  };
  const sources = sourceCache(async (path): Promise<Source> => {
    // A file the server cannot read a grid for shows its frames at their own times.
    const grid = fetch(
      `/api/cutroom/projects/${encodeURIComponent(projectId)}/media/frames?path=${encodeURIComponent(path)}`,
      { signal: closing.signal },
    )
      .then(async (response) =>
        response.ok ? FrameGridSchema.parse(await response.json()) : null,
      )
      .catch(() => null);
    const lanes = (url: string) =>
      Promise.all([
        openSource(url, closing.signal),
        openSource(url, closing.signal),
      ]);
    // A file this browser cannot decode or read, such as HEVC, ProRes or Matroska, plays from
    // its editing proxy: the same frames at the same times. HyperFrames draws until it exists.
    const [{ decoder, intrinsic }, second] = await lanes(
      mediaUrl(projectId, path),
    ).catch(async (error: unknown) => {
      const url = `/api/cutroom/projects/${encodeURIComponent(projectId)}/media/proxy?path=${encodeURIComponent(path)}`;
      const response = await fetch(url, {
        headers: { range: "bytes=0-0" },
        signal: closing.signal,
      });
      await response.body?.cancel();
      if (response.status === 202) {
        if (!preparing.has(path)) void proxyReady(url, path).catch(() => {});
        throw new Error(`${path} is being prepared for editing`);
      }
      if (!response.ok) throw error;
      return lanes(url);
    });
    const proxyUrl = `/api/cutroom/projects/${encodeURIComponent(projectId)}/media/scrub?path=${encodeURIComponent(path)}`;
    let askedAt = -Infinity;
    let asking: Promise<void> | null = null;
    const found: Source = {
      lanes: [decoder, second.decoder],
      playing: decoder,
      proxy: null,
      intrinsic,
      grid: await grid,
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
        const drawingPlan = plan;
        if (!drawingPlan) continue;
        try {
          await drawFrame(drawingPlan);
        } catch (error) {
          if (plan === drawingPlan && !closing.signal.aborted)
            stop(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      drawing = false;
    }
  };

  const placed = (
    layer: Shown,
    frame: VideoFrame,
    turn: Layer["turn"],
    intrinsic: Source["intrinsic"],
    grade: GradeTexture | null,
  ): Layer => {
    const { clip } = layer;
    return {
      frame,
      turn,
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
      grade,
    };
  };

  const drawFrame = async (drawingPlan: Plan) => {
    const view = useTimeline.getState().view;
    const { frame, state } = useTransport.getState();
    if (!view || view.composition !== "index.html") return;
    const shown = visibleAt(view.timeline, drawingPlan, frame);
    if (!shown) return stop("a clip at the playhead is not one it can draw");
    const moving = state.kind === "scrubbing" || state.kind === "shuttle";
    const playing = state.kind === "playing";
    const { draft } = usePreviewGrade.getState();
    const { bypass } = useGradeBypass.getState();
    const textures = Promise.all(
      shown.map(({ clip }) => {
        const editing = draft?.clipId === clip.id;
        const grade = editing ? draft.grade : clip.grade;
        return grade && !bypass ? grades.get(grade, editing) : null;
      }),
    ).then(
      (textures) => ({ textures }),
      (error: unknown) => ({ error }),
    );
    const pictures = await Promise.all(
      shown.map(async (layer) => {
        const found = await source(layer.clip.src!);
        if (!found.proxy) void found.askProxy();
        const index = indexAt(found, layer.time);
        const lane = laneFor(found, index);
        // Moving seeks draw the proxy, whose frame N is the source's frame N.
        const decoder = (moving ? found.proxy : null) ?? lane;
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
          decoder,
          request: decoder.frame(index, playing),
        };
      }),
    );
    const paint = async (
      frames: VideoFrame[],
      from: SourceDecoder[],
      standIn: boolean,
    ) => {
      // A page that paints nothing shows the browser's white canvas, as frame capture does.
      if (plan !== drawingPlan || closing.signal.aborted || compositor.lost())
        return;
      const baked = await textures;
      if ("error" in baked) throw baked.error;
      await compositor.draw(
        pictures.map(({ layer, found }, at) =>
          // The proxy is stored upright; a phone's file may be stored turned.
          placed(
            layer,
            frames[at]!,
            from[at]!.rotation,
            found.intrinsic,
            baked.textures[at]!,
          ),
        ),
        drawingPlan.background ?? "#ffffff",
        drawingPlan.width,
        drawingPlan.height,
      );
      // A refusal or detachment during GPU upload must not make this canvas visible again.
      if (plan !== drawingPlan || closing.signal.aborted) return;
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
        if (standIns.length && !wanted)
          await paint(
            standIns,
            pictures.map(({ cold, found, decoder }) =>
              cold ? found.proxy! : decoder,
            ),
            true,
          );
      } finally {
        for (const picture of standIns) picture.close();
      }
    }
    const frames = await settle(pictures.map(({ request }) => request));
    try {
      if (pictures.some(({ cold }) => cold) && wanted) return;
      await paint(
        frames,
        pictures.map(({ decoder }) => decoder),
        false,
      );
    } finally {
      for (const picture of frames) picture.close();
    }
    if (plan !== drawingPlan || closing.signal.aborted) return;
    for (const { found, lane, index } of pictures) {
      if (moving) continue;
      found.playing = lane;
      if (playing) lane.prefetch(index + 1, index + lane.room(8));
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
    let preparedGrade = false;
    for (const { frame: at, layer } of upcoming.list) {
      if (at <= frame || at > frame + span) continue;
      if (
        !preparedGrade &&
        layer.clip.grade &&
        !useGradeBypass.getState().bypass
      ) {
        preparedGrade = true;
        void grades.get(layer.clip.grade).catch(() => {});
      }
      const src = layer.clip.src!;
      // At rest, only the next opening of each file: the spare lane holds one.
      if (count === PREPARED && sources.has(src)) continue;
      sources.add(src);
      void source(src)
        .then((found) => {
          const index = indexAt(found, layer.time);
          // The playing lane may hold it now, but drops it as the playhead moves on.
          const spare = found.lanes.find((lane) => lane !== found.playing)!;
          if (!spare.has(index) && !spare.reaches(index))
            spare.prefetch(index, index + spare.room(count) - 1);
        })
        .catch(() => {});
    }
  };

  let planRequest = 0;
  const refresh = async () => {
    const request = ++planRequest;
    const isCurrent = () => request === planRequest && !closing.signal.aborted;
    const view = useTimeline.getState().view;
    // The timeline's first read starts the plan's.
    if (!view) return;
    if (view.composition !== "index.html") {
      plan = null;
      return stop("only the entry composition plays through it");
    }
    let next: PipelinePlan;
    try {
      const response = await fetch(
        `/api/cutroom/projects/${encodeURIComponent(projectId)}/pipeline`,
        { signal: closing.signal },
      );
      next = PipelineResponseSchema.parse(await response.json()).plan;
    } catch (error) {
      if (!isCurrent()) return;
      plan = null;
      return stop(error instanceof Error ? error.message : String(error));
    }
    if (!isCurrent()) return;
    if ("reason" in next) {
      plan = null;
      return stop(next.reason);
    }
    plan = next;
    // Which videos HyperFrames keeps, and why, for whoever tries the setting, each said once.
    for (const reason of Object.values(next.hyperframes))
      if (!explained.has(reason)) {
        explained.add(reason);
        console.info(`[pipeline] HyperFrames draws a clip: ${reason}`);
      }
    const drawn = Object.keys(next.drawable);
    if (drawn.join("\n") !== usePipeline.getState().drawn.join("\n"))
      usePipeline.setState({ drawn });
    sources.forgetFailures();
    // Open every file now: opening one mid-playback costs the clock a few frames.
    for (const clip of view.timeline.clips)
      if (clip.src && next.drawable[clip.id])
        void source(clip.src).catch(() => {});
    void draw();
  };
  void refresh();

  const unsubscribe = [
    usePreviewGrade.subscribe(() => void draw()),
    useGradeBypass.subscribe(() => void draw()),
    useTransport.subscribe((state, previous) => {
      if (state.frame !== previous.frame || state.state !== previous.state)
        void draw();
    }),
    useTimeline.subscribe((state, previous) => {
      if (state.view === previous.view) return;
      // The shown view already holds the edit: draw it now, and let the server's plan follow.
      void draw();
      if (
        state.view?.revision !== previous.view?.revision ||
        state.view?.composition !== previous.view?.composition
      )
        void refresh();
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
    grades.dispose();
    compositor.dispose();
  };
}
