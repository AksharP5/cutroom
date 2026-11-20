import { PipelineResponseSchema } from "../../shared/pipeline";
import type { FootageColour, PipelinePlan } from "../../shared/pipeline";
import type { Clip, TimelineView, Version } from "../../shared/timeline/schema";
import {
  activeVersion,
  consumedSource,
  nextAudition,
  versionStart,
} from "../../shared/timeline/versions";
import { framesBefore } from "../../shared/timeline/transition";
import { useVersions } from "../edit/versions";
import { localMediaPath } from "../../shared/media";
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
  probe?: FootageColour,
): VideoColorSpaceInit {
  const guess = chromeColourGuess(
    track.height,
    track.codec.startsWith("avc") ? "h264" : "hevc",
  );
  const matrix = probe?.matrix ?? track.colour?.matrix ?? guess;
  const fallback = matrix === "bt709" ? "bt709" : guess;
  return {
    primaries: probe?.primaries ?? track.colour?.primaries ?? fallback,
    transfer: probe?.transfer ?? track.colour?.transfer ?? fallback,
    matrix,
    fullRange: probe?.fullRange ?? track.colour?.fullRange ?? false,
  };
}

async function openSource(
  url: string,
  signal: AbortSignal,
  colour?: FootageColour,
) {
  const { read, size } = await openRanges(url, signal);
  const track = await readVideoTrack(read, size);
  if (!(await SourceDecoder.supported(track)))
    throw new Error(`This browser cannot decode ${track.codec}.`);
  const turned = track.rotation % 180 !== 0;
  return {
    createDecoder: SourceDecoder.forTrack(
      track,
      read,
      size,
      colourOf(track, colour),
    ),
    intrinsic: {
      width: turned ? track.height : track.width,
      height: turned ? track.width : track.height,
    },
  };
}

/** Attaches the pipeline to its canvas for one project. */
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
  let sourceColours: Record<string, FootageColour> = {};
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
      media.forgetFailures();
      sources.forgetFailures();
      void draw();
    } finally {
      preparing.delete(path);
    }
  };
  const media = sourceCache(async (src) => {
    const path = localMediaPath("index.html", src);
    if (path === null)
      throw new Error("Choose footage from the project folder.");
    // A file the server cannot read a grid for shows its frames at their own times.
    const grid = fetch(
      `/api/cutroom/projects/${encodeURIComponent(projectId)}/media/frames?path=${encodeURIComponent(path)}`,
      { signal: closing.signal },
    )
      .then(async (response) =>
        response.ok ? FrameGridSchema.parse(await response.json()) : null,
      )
      .catch(() => null);
    // A file this browser cannot decode or read, such as HEVC, ProRes or Matroska, plays from
    // its editing proxy: the same frames at the same times. HyperFrames draws until it exists.
    const opened = await openSource(
      mediaUrl(projectId, path),
      closing.signal,
      sourceColours[src],
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
      return openSource(url, closing.signal);
    });
    return { ...opened, grid: await grid, path };
  });
  const scrubs = sourceCache((path) =>
    openSource(
      `/api/cutroom/projects/${encodeURIComponent(projectId)}/media/scrub?path=${encodeURIComponent(path)}`,
      closing.signal,
    ),
  );
  const sources = sourceCache(async (src): Promise<Source> => {
    const { createDecoder, intrinsic, grid, path } = await media.get(src);
    let askedAt = -Infinity;
    let asking: Promise<void> | null = null;
    const decoder = createDecoder();
    const found: Source = {
      lanes: [decoder, createDecoder()],
      playing: decoder,
      proxy: null,
      intrinsic,
      grid,
      // A proxy still being made answers 202. Moving seeks use the source until it exists, and
      // a draw that wants it asks again, at most every two seconds.
      askProxy: () => {
        if (found.proxy || asking || performance.now() - askedAt < 2000)
          return asking;
        askedAt = performance.now();
        scrubs.forgetFailures();
        asking = scrubs
          .get(path)
          .then(({ createDecoder }) => {
            if (!closing.signal.aborted) found.proxy = createDecoder("scrub");
          })
          .catch(() => {})
          .finally(() => (asking = null));
        return asking;
      },
    };
    return found;
  });
  const source = sources.get;

  type Prepared = {
    decoder: SourceDecoder;
    intrinsic: { width: number; height: number };
    grid: FrameGrid;
  };
  let audition: {
    key: string;
    clip: Clip;
    takes: Map<number, Promise<Prepared>>;
    initial: number;
    proxyPaths: Set<string>;
  } | null = null;
  const disposeAudition = () => {
    if (!audition) return;
    for (const take of audition.takes.values())
      void take.then(
        ({ decoder }) => decoder.close(),
        () => {},
      );
    const view = useTimeline.getState().view;
    const used = new Set(view?.timeline.clips.map(({ src }) => src));
    for (const { src } of audition.clip.versions ?? []) {
      if (used.has(src)) continue;
      const path = localMediaPath(view?.composition ?? "index.html", src);
      if (path !== null) scrubs.remove(path);
      media.remove(src);
      void sources.remove(src)?.then(closeSource, () => {});
    }
    audition = null;
  };
  const auditionTime = (
    clip: Clip,
    version: Version,
    frame: number,
    view: TimelineView,
  ) =>
    versionStart(version, view.timeline.fps) +
    consumedSource(clip, frame - clip.start, view.timeline.fps) +
    1e-5;
  function prepareAudition(
    view: TimelineView,
    frame: number,
    playing: boolean,
  ) {
    const { open, hovered } = useVersions.getState();
    const clip = open
      ? view.timeline.clips.find(({ id }) => id === open)
      : undefined;
    if (clip?.kind !== "video" || !clip.versions || !plan?.drawable[clip.id]) {
      disposeAudition();
      return null;
    }
    const key = JSON.stringify([
      open,
      clip.versions.map(({ src, sourceIn, fits, offline }) => [
        src,
        sourceIn,
        fits,
        offline,
      ]),
    ]);
    if (audition?.key !== key) {
      disposeAudition();
      audition = {
        key,
        clip,
        takes: new Map(),
        initial: activeVersion(clip),
        proxyPaths: new Set(),
      };
      scrubs.forgetFailures();
      for (const version of clip.versions) {
        if (version.offline || version.fits === false) continue;
        const path = localMediaPath(view.composition, version.src);
        if (path === null || audition.proxyPaths.has(path)) continue;
        audition.proxyPaths.add(path);
        void scrubs.get(path).catch(() => {});
      }
    }
    const warming = audition;
    const selected = hovered ?? activeVersion(clip);
    const eligible = clip.versions.flatMap((version, index) =>
      version.fits === false || version.offline ? [] : [index],
    );
    const next = nextAudition(eligible, selected);
    const resident = new Set([selected, next]);
    for (const [index, take] of warming.takes) {
      if (resident.has(index)) continue;
      warming.takes.delete(index);
      void take.then(
        ({ decoder }) => decoder.close(),
        () => {},
      );
    }
    for (const index of resident) {
      if (index === undefined) continue;
      const version = clip.versions[index];
      if (
        !version ||
        version.offline ||
        version.fits === false ||
        index === warming.initial ||
        warming.takes.has(index)
      )
        continue;
      const prepared = media
        .get(version.src)
        .then(({ createDecoder, intrinsic, grid }) => ({
          decoder: createDecoder("audition"),
          intrinsic,
          grid,
        }));
      prepared.catch(() => {});
      warming.takes.set(index, prepared);
    }
    const first =
      clip.start - (clip.transitionIn ? framesBefore(clip.transitionIn) : 0);
    const warmAt = playing
      ? Math.max(first, Math.min(frame, clip.start + clip.duration - 1))
      : clip.start;
    for (const [index, pending] of warming.takes) {
      const version = clip.versions[index]!;
      void pending.then(
        ({ decoder, grid }) => {
          if (warming !== audition) return;
          const seconds = auditionTime(clip, version, warmAt, view);
          const sourceFrame = decoder.indexAt(
            grid ? frameSeek(grid, seconds) : seconds,
          );
          const end = Math.min(
            decoder.frameCount - 1,
            sourceFrame + decoder.room(5) - 1,
          );
          if (!decoder.has(sourceFrame) || !decoder.has(end))
            decoder.prefetch(sourceFrame, end);
        },
        () => {},
      );
    }
    // The original take borrows the main pipeline's decoder when it is next.
    if (next === warming.initial && warming.clip.src) {
      const src = warming.clip.src;
      const original = clip.versions[activeVersion(warming.clip)]!;
      void source(src).then(
        (found) => {
          if (warming !== audition) return;
          const index = indexAt(
            found,
            auditionTime(clip, original, warmAt, view),
          );
          const lane = laneFor(found, index);
          const end = Math.min(lane.frameCount - 1, index + lane.room(5) - 1);
          if (!lane.has(index) || !lane.has(end)) lane.prefetch(index, end);
        },
        () => {},
      );
    }
    const version = clip.versions[selected];
    return version && !version.offline && version.fits !== false
      ? { clip, version, decoder: warming.takes.get(selected) }
      : null;
  }

  async function auditionStandIn(path: string, index: number) {
    const { createDecoder } = await scrubs.get(path);
    if (closing.signal.aborted || !audition?.proxyPaths.has(path))
      throw new Error("The versions list closed.");
    const proxy = createDecoder("scrub");
    try {
      const frame = await proxy.frame(index);
      return { frame, decoder: proxy };
    } finally {
      proxy.close();
    }
  }

  const closeSource = ({ lanes, proxy }: Source) => {
    for (const lane of lanes) lane.close();
    proxy?.close();
  };

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
    const auditionAtDraw = useVersions.getState();
    const alternate = prepareAudition(view, frame, state.kind === "playing");
    const shown = visibleAt(view.timeline, drawingPlan, frame);
    if (!shown) {
      stop("the layers at the playhead need to be composited together");
      if (state.kind === "playing") prepare(view, frame, LOOKAHEAD, OPENING);
      return;
    }
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
        const selected =
          alternate?.clip.id === layer.clip.id ? alternate : null;
        if (selected?.decoder) {
          const { decoder, intrinsic, grid } = await selected.decoder;
          const seconds = auditionTime(
            layer.clip,
            selected.version,
            frame,
            view,
          );
          const index = decoder.indexAt(
            grid ? frameSeek(grid, seconds) : seconds,
          );
          const path = localMediaPath(view.composition, selected.version.src);
          return {
            layer,
            found: { intrinsic, proxy: null },
            index,
            lane: decoder,
            decoder,
            standIn:
              path && !decoder.has(index) && !decoder.reaches(index)
                ? () => auditionStandIn(path, index)
                : null,
            request: decoder.frame(index, playing),
          };
        }
        const found = await source(selected?.version.src ?? layer.clip.src!);
        if (!found.proxy) void found.askProxy();
        const index = indexAt(
          found,
          selected
            ? auditionTime(layer.clip, selected.version, frame, view)
            : layer.time,
        );
        const lane = laneFor(found, index);
        // Moving seeks draw the proxy, whose frame N is the source's frame N.
        const decoder = (moving ? found.proxy : null) ?? lane;
        return {
          layer,
          found,
          index,
          lane,
          // A frame its lane must decode from a keyframe, at rest, when the proxy has it.
          standIn:
            !moving &&
            !playing &&
            found.proxy &&
            !lane.has(index) &&
            !lane.reaches(index)
              ? async () => {
                  const decoder = found.proxy!;
                  return { decoder, frame: await decoder.frame(index) };
                }
              : null,
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
      const currentAudition = useVersions.getState();
      if (
        auditionAtDraw.open !== currentAudition.open ||
        auditionAtDraw.hovered !== currentAudition.hovered
      )
        return;
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
    const exact = settle(pictures.map(({ request }) => request));
    const hasStandIn = pictures.some(({ standIn }) => standIn);
    let provisional: Promise<void> | undefined;
    if (hasStandIn) {
      // Paint a scrub-proxy picture if it arrives first. A missing or late proxy can't delay
      // an exact frame, and either path closes the frames it owns.
      let arrived = false;
      const standIns = Promise.allSettled(
        pictures.map(({ standIn, request, decoder }) =>
          standIn
            ? standIn()
            : request.then((frame) => ({ decoder, frame: frame.clone() })),
        ),
      ).then(async (results) => {
        const ready = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        try {
          if (
            !arrived &&
            (alternate || !wanted) &&
            ready.length === pictures.length
          ) {
            provisional = paint(
              ready.map(({ frame }) => frame),
              ready.map(({ decoder }) => decoder),
              true,
            ).catch(() => {});
            await provisional;
          }
        } finally {
          for (const { frame } of ready) frame.close();
        }
      });
      await Promise.race([
        exact.then(() => {
          arrived = true;
        }),
        standIns,
      ]);
    }
    const frames = await exact;
    try {
      if (provisional) await provisional;
      if (hasStandIn && !alternate && wanted) return;
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
      if ("playing" in found) found.playing = lane;
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
    let response: ReturnType<typeof PipelineResponseSchema.parse>;
    try {
      const request = await fetch(
        `/api/cutroom/projects/${encodeURIComponent(projectId)}/pipeline`,
        { signal: closing.signal },
      );
      response = PipelineResponseSchema.parse(await request.json());
    } catch (error) {
      if (!isCurrent()) return;
      plan = null;
      return stop(error instanceof Error ? error.message : String(error));
    }
    if (!isCurrent()) return;
    const { plan: next, colours } = response;
    // Which videos HyperFrames keeps, and why, for whoever tries the setting, each said once.
    for (const reason of Object.values(next.hyperframes ?? {}))
      if (!explained.has(reason)) {
        explained.add(reason);
        console.info(`[pipeline] HyperFrames draws a clip: ${reason}`);
      }
    if ("reason" in next) {
      plan = null;
      return stop(next.reason);
    }
    sourceColours = colours;
    plan = next;
    const drawn = Object.keys(next.drawable);
    const native = Object.keys(next.hyperframes);
    const previous = usePipeline.getState();
    if (
      drawn.join("\n") !== previous.drawn.join("\n") ||
      native.join("\n") !== previous.native.join("\n")
    )
      usePipeline.setState({ drawn, native });
    media.forgetFailures();
    sources.forgetFailures();
    // Read the index now: opening one mid-playback costs the clock a few frames.
    for (const clip of view.timeline.clips)
      if (clip.src && next.drawable[clip.id])
        void media.get(clip.src).catch(() => {});
    void draw();
  };
  void refresh();

  const unsubscribe = [
    useVersions.subscribe((state, previous) => {
      if (state.open !== previous.open || state.hovered !== previous.hovered)
        queueMicrotask(() => void draw());
    }),
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
  return {
    refreshDependencies() {
      plan = null;
      usePipeline.setState({ active: false });
      void refresh();
    },
    dispose() {
      closing.abort();
      disposeAudition();
      compositor.dispose();
      grades.dispose();
      for (const stop of unsubscribe) stop();
      usePipeline.setState({ active: false });
      for (const found of sources.values())
        void found.then(({ lanes, proxy }) => {
          for (const lane of lanes) lane.close();
          proxy?.close();
        });
    },
  };
}
