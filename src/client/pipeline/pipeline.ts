import { fetchPictureSource, mediaAssetUrl } from "../mediaAsset";
import {
  FOOTAGE_PIXEL_LIMIT,
  PipelineResponseSchema,
} from "../../shared/pipeline";
import type { FootageColour, PipelinePlan } from "../../shared/pipeline";
import type { Clip, TimelineView, Version } from "../../shared/timeline/schema";
import {
  activeVersion,
  auditionNeighbours,
  versionSourceAt,
} from "../../shared/timeline/versions";
import { framesBefore } from "../../shared/timeline/transition";
import { useVersions } from "../edit/versions";
import { localMediaPath } from "../../shared/media";
import { isTimelinePath } from "../../shared/sourcePaths";
import { useGradeBypass, usePreviewGrade } from "../edit/preview";
import { acquireGrades } from "./grades";
import type { GradeTexture } from "./grades";
import { useTimeline } from "../edit/timeline";
import { useTransport } from "../edit/transport";
import { createCompositor } from "./compositor";
import type { Layer } from "./compositor";
import { SourceDecoder } from "./decoder";
import { openRanges, readVideoTrack } from "./mp4";
import { appearances, coversFrame, frameLayersAt } from "./layers";
import type { Appearance, Shown } from "./layers";
import { sourceCache } from "./sources";
import { usePipeline } from "./setting";
import { chromeColourGuess } from "../../shared/videoColour";
import { secondsOf } from "../../shared/timeline/piece";
import type { SourceTime } from "../../shared/timeline/piece";
import { pictureTime } from "../../shared/timeline/pictureSource";
import type { PictureSource } from "../../shared/timeline/pictureSource";
import { useWorkspace } from "../workspace";
import { clipMatteState, useMatteView, useMattes } from "../edit/mattes";
import { matteFrameAt } from "../../shared/matte";

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
  /** The file's pictures as export selects them, or null to show them at their own times. */
  pictures: PictureSource | null;
}

/** The frame a source shows at a media time: the one export writes there. */
const indexAt = (found: Source, asked: number, source?: SourceTime) =>
  found.playing.indexAt(pictureTime(found.pictures, asked, source));

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
  {
    colour,
    scrubProxy = false,
  }: { colour?: FootageColour; scrubProxy?: boolean } = {},
) {
  const { read, size } = await openRanges(url, signal);
  const track = await readVideoTrack(read, size);
  if (!scrubProxy && track.width * track.height > FOOTAGE_PIXEL_LIMIT)
    throw new Error(
      `The playing file is ${track.width} × ${track.height}, above the pipeline's 1080p limit.`,
    );
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
export function attachPipeline(
  projectId: string,
  canvas: HTMLCanvasElement,
  /** Over the preview: cutouts above HyperFrames' layers, made on first use. */
  aboveCanvas: HTMLCanvasElement,
) {
  const closing = new AbortController();
  let compositor = createCompositor(canvas);
  let aboveCompositor: ReturnType<typeof createCompositor> | null = null;
  /** Whether the canvas over the preview holds a picture to clear. */
  let aboveDrawn = false;
  const grades = acquireGrades(projectId);
  // A GPU under memory pressure can drop the context; HyperFrames draws until it comes back.
  canvas.addEventListener(
    "webglcontextlost",
    (event) => {
      event.preventDefault();
      compositor.dispose();
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
  aboveCanvas.addEventListener(
    "webglcontextlost",
    (event) => {
      event.preventDefault();
      aboveCompositor?.dispose();
      aboveCompositor = null;
      aboveDrawn = false;
    },
    { signal: closing.signal },
  );
  let plan: Plan | null = null;
  let sourceColours: Record<string, FootageColour> = {};
  let sourceRefusals: Record<string, string> = {};
  const explained = new Set<string>();
  let stopped: string | null = null;
  const stop = (reason: string) => {
    // Why the composition stays with HyperFrames, for whoever tries the setting, said once.
    if (!closing.signal.aborted && stopped !== reason)
      console.info(`[pipeline] off: ${reason}`);
    stopped = reason;
    usePipeline.setState({ active: false });
    aboveCanvas.hidden = true;
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
  // A file the server cannot index shows its frames at their own times.
  const pictureSources = sourceCache((path) =>
    fetchPictureSource(
      mediaAssetUrl(projectId, "frames", path),
      closing.signal,
    ),
  );
  const media = sourceCache(async (src) => {
    const path = localMediaPath("index.html", src);
    if (path === null)
      throw new Error("Choose footage from the project folder.");
    const pictures = pictureSources.get(path);
    // A file this browser cannot decode or read, such as HEVC, ProRes or Matroska, plays from
    // its editing proxy: the same frames at the same times. HyperFrames draws until it exists.
    const opened = await openSource(mediaUrl(projectId, path), closing.signal, {
      colour: sourceColours[src],
    }).catch(async (error: unknown) => {
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
    // A long recording's first scan takes seconds. Draw its frames at their own times until
    // the index comes.
    const ready = await Promise.race([
      pictures,
      new Promise<undefined>((resolve) => setTimeout(resolve, 400)),
    ]);
    return { ...opened, pictures: ready ?? null, indexed: pictures, path };
  });
  const scrubs = sourceCache((path) =>
    openSource(
      `/api/cutroom/projects/${encodeURIComponent(projectId)}/media/scrub?path=${encodeURIComponent(path)}`,
      closing.signal,
      { scrubProxy: true },
    ),
  );
  const sources = sourceCache(async (src): Promise<Source> => {
    const { createDecoder, intrinsic, pictures, indexed, path } =
      await media.get(src);
    let askedAt = -Infinity;
    let asking: Promise<void> | null = null;
    const decoder = createDecoder();
    const found: Source = {
      lanes: [decoder, createDecoder()],
      playing: decoder,
      proxy: null,
      intrinsic,
      pictures,
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
    if (!pictures)
      void indexed.then((late) => {
        if (!late || closing.signal.aborted) return;
        found.pictures = late;
        void draw();
      });
    return found;
  });
  const source = sources.get;
  /** One decoder per matte file; mattes are small, so one lane serves playback and seeks. */
  const mattes = sourceCache(async (file) =>
    (
      await openSource(mediaUrl(projectId, file), closing.signal)
    ).createDecoder(),
  );
  /**
   * The matte frame for a picture whose background is removed, once its whole range is made; the
   * original picture shows until then. Null keeps the background.
   */
  const matteFor = (
    view: TimelineView,
    layer: Shown,
    playing: boolean,
  ): Promise<VideoFrame | null> | null => {
    const status = useMattes.getState().status;
    const state = clipMatteState(
      status,
      view.composition,
      layer.clip,
      view.timeline.fps,
    );
    if (state?.state !== "ready") return null;
    const entry = status!.mattes.find((entry) => {
      const frame = matteFrameAt(entry, layer.time);
      return (
        entry.src === state.src &&
        frame >= entry.first &&
        frame < entry.first + entry.frames
      );
    });
    // A frame no matte covers, such as one past the clip's handles, shows the original picture;
    // a frame the model found empty shows nothing of the clip.
    if (!entry) return null;
    if (!entry.subject) return Promise.resolve(null);
    const index = matteFrameAt(entry, layer.time) - entry.first;
    return mattes.get(entry.file).then((decoder) => {
      const at = decoder.indexAt(
        decoder.firstTime + (index + 0.25) / entry.rate,
      );
      const frame = decoder.frame(at, playing);
      // Playing reads on, as the source's lanes do, so no matte frame waits on the decoder.
      if (playing) decoder.prefetch(at + 1, at + decoder.room(8));
      return frame;
    });
  };

  type Prepared = {
    decoder: SourceDecoder;
    intrinsic: { width: number; height: number };
    pictures: PictureSource | null;
  };
  let audition: {
    key: string;
    clip: Clip;
    takes: Map<number, Promise<Prepared>>;
    initial: number;
    hovered: number | null;
    scrub: SourceDecoder | null;
  } | null = null;
  const disposeAudition = () => {
    if (!audition) return;
    audition.scrub?.close();
    audition.scrub = null;
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
      if (path !== null) {
        scrubs.remove(path);
        pictureSources.remove(path);
      }
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
    versionSourceAt(clip, version, frame, view.timeline.fps) +
    // The runtime seeks just past the frame's start, as HyperFrames does.
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
        sourceRefusals[src],
      ]),
    ]);
    if (audition?.key !== key) {
      disposeAudition();
      audition = {
        key,
        clip,
        takes: new Map(),
        initial: activeVersion(clip),
        hovered: null,
        scrub: null,
      };
      scrubs.forgetFailures();
      const paths = new Set<string>();
      for (const version of clip.versions) {
        if (
          version.offline ||
          version.fits === false ||
          sourceRefusals[version.src]
        )
          continue;
        const path = localMediaPath(view.composition, version.src);
        if (path === null || paths.has(path)) continue;
        paths.add(path);
        void media.get(version.src).catch(() => {});
      }
    }
    const warming = audition;
    const changed = hovered !== warming.hovered;
    if (changed) scrubs.forgetFailures();
    warming.hovered = hovered;
    const selected = hovered ?? activeVersion(clip);
    const eligible = clip.versions.flatMap((version, index) =>
      version.fits === false || version.offline || sourceRefusals[version.src]
        ? []
        : [index],
    );
    // Moving one row either way finds its decoder open; the saved take uses the main decoder.
    // Until the first hover, only the next row warms, so it does not compete with a cold take.
    const neighbours = auditionNeighbours(eligible, selected);
    const resident = new Set([
      eligible.includes(selected) ? selected : undefined,
      ...(hovered === null ? neighbours.slice(-1) : neighbours),
    ]);
    // A take's scrub proxy can need encoding; ask only for the takes a move can reach next.
    for (const index of [selected, ...neighbours]) {
      const path = eligible.includes(index)
        ? localMediaPath(view.composition, clip.versions[index]!.src)
        : null;
      if (path !== null) void scrubs.get(path).catch(() => {});
    }
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
        .then(({ createDecoder, intrinsic, pictures }) => ({
          decoder: createDecoder("audition"),
          intrinsic,
          pictures,
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
      // The selected take's draw asks for its frame first, then prefetches the following frames.
      if (changed && index === selected) continue;
      const version = clip.versions[index]!;
      void pending.then(
        ({ decoder, pictures }) => {
          if (warming !== audition) return;
          const seconds = auditionTime(clip, version, warmAt, view);
          const sourceFrame = decoder.indexAt(pictureTime(pictures, seconds));
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
    // The original take borrows the main pipeline's decoder whenever another row is shown.
    if (selected !== warming.initial && warming.clip.src) {
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
      ? {
          clip,
          version,
          decoder: warming.takes.get(selected),
          refusal: sourceRefusals[version.src],
          warming,
          changed,
        }
      : null;
  }

  async function auditionStandIn(
    path: string,
    indexAt: (proxy: SourceDecoder) => number,
    warming: NonNullable<typeof audition>,
    needed: () => boolean,
  ) {
    const { createDecoder, intrinsic } = await scrubs.get(path);
    if (closing.signal.aborted || audition !== warming || !needed())
      throw new Error("The audition frame was superseded.");
    const proxy = createDecoder("scrub");
    warming.scrub?.close();
    warming.scrub = proxy;
    try {
      const frame = await proxy.frame(indexAt(proxy));
      return { frame, rotation: proxy.rotation, intrinsic };
    } finally {
      if (warming.scrub === proxy) {
        proxy.close();
        warming.scrub = null;
      }
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
      // An edit publishes its new timeline and playhead in the same key event.
      // Read them together so decoding does not start at the old playhead.
      await Promise.resolve();
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

  /** The saved refine, or the one being dragged; Show matte draws it in black and white. */
  const matteLayer = (clip: Clip, frame: VideoFrame) => {
    const { draft, shown } = useMatteView.getState();
    const refine = draft?.clipId === clip.id ? draft : clip.background!;
    return {
      frame,
      shrink: refine.shrink,
      soften: refine.soften,
      show: shown === clip.id,
    };
  };

  const placed = (
    layer: Shown,
    frame: VideoFrame,
    turn: Layer["turn"],
    intrinsic: Source["intrinsic"],
    grade: GradeTexture | null,
    matte: VideoFrame | null,
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
      matte: matte && clip.background ? matteLayer(clip, matte) : null,
    };
  };

  const drawFrame = async (drawingPlan: Plan) => {
    const { view, selection } = useTimeline.getState();
    const { frame, state } = useTransport.getState();
    if (!view || !isTimelinePath(view.composition)) return;
    const auditionAtDraw = useVersions.getState();
    const alternate = prepareAudition(view, frame, state.kind === "playing");
    const { draft } = usePreviewGrade.getState();
    const { bypass } = useGradeBypass.getState();
    const shown = frameLayersAt(
      view.timeline,
      drawingPlan,
      frame,
      draft?.clipId,
    );
    // Cutouts over HyperFrames' layers go on the canvas above the preview; the rest below it.
    const layers = shown && [...shown.pictures, ...(shown.above ?? [])];
    const lowerCount = shown?.pictures.length ?? 0;
    if (!shown) {
      stop("the layers at the playhead need to be composited together");
      if (state.kind === "playing") prepare(view, frame, LOOKAHEAD, OPENING);
      return;
    }
    if (
      alternate?.refusal &&
      layers!.some(({ clip }) => clip.id === alternate.clip.id)
    ) {
      stop(alternate.refusal);
      return;
    }
    const moving = state.kind === "scrubbing" || state.kind === "shuttle";
    const playing = state.kind === "playing";
    const { fileChanges } = useWorkspace.getState();
    const textureOf = ({ clip }: Pick<Shown, "clip">) => {
      const editing = draft?.clipId === clip.id;
      const grade = editing ? draft.grade : clip.grade;
      const key =
        grade && !bypass
          ? grades.identify(grade, view.composition, fileChanges, editing)
          : null;
      return key ? grades.get(key) : null;
    };
    const textures = Promise.all(layers!.map(textureOf)).catch(
      (error: unknown) => ({ error }),
    );
    const adjustments =
      !bypass &&
      shown.adjustments?.length &&
      Promise.all(
        shown.adjustments.map(async ({ clip, after }) => {
          const grade = await textureOf({ clip });
          return grade ? { after, grade } : null;
        }),
      ).then(
        (results) => results.filter((item) => item !== null),
        (error: unknown) => ({ error }),
      );
    type Picture = {
      frame: VideoFrame;
      rotation: SourceDecoder["rotation"];
      intrinsic: Source["intrinsic"];
    };
    // Mattes are asked for with the pictures. A clip whose matte is missing or failed to decode
    // shows its original picture; a frame the model found empty shows nothing of the clip.
    const empty = Symbol("empty");
    const matteFrames = Promise.all(
      layers!.map(
        (layer) =>
          matteFor(view, layer, state.kind === "playing")
            ?.then((frame) => frame ?? empty)
            .catch(() => null) ?? null,
      ),
    );
    let arrived = false;
    let hasStandIn = false;
    const pictures = layers!.map((layer) => {
      const selected = alternate?.clip.id === layer.clip.id ? alternate : null;
      const src = selected?.version.src ?? layer.clip.src!;
      const seconds = selected
        ? auditionTime(layer.clip, selected.version, frame, view)
        : layer.time;
      const prepare = async () => {
        if (selected?.decoder) {
          const { decoder, intrinsic, pictures } = await selected.decoder;
          const index = decoder.indexAt(pictureTime(pictures, seconds));
          return { intrinsic, index, lane: decoder, decoder, found: null };
        }
        const found = await source(src);
        if (!found.proxy) void found.askProxy();
        const index = indexAt(
          found,
          seconds,
          selected ? undefined : layer.source(),
        );
        const lane = laneFor(found, index);
        // Moving seeks draw the proxy, whose frame N is the source's frame N.
        const decoder = (moving ? found.proxy : null) ?? lane;
        return { intrinsic: found.intrinsic, index, lane, decoder, found };
      };
      let original:
        (Awaited<ReturnType<typeof prepare>> & { cached: boolean }) | undefined;
      const requested = prepare().then((picture) => {
        const { decoder, index } = picture;
        original = {
          ...picture,
          cached: decoder.has(index) || decoder.reaches(index),
        };
        return {
          ...original,
          request: decoder.frame(index, playing),
        };
      });
      const exact = requested.then(
        async ({ request, decoder, ...picture }) => ({
          ...picture,
          rotation: decoder.rotation,
          frame: await request,
        }),
      );
      const path =
        selected?.decoder || selected?.changed
          ? localMediaPath(view.composition, src)
          : null;
      const standIn = async (): Promise<Picture> => {
        const needed = () =>
          !arrived &&
          auditionAtDraw.open === useVersions.getState().open &&
          auditionAtDraw.hovered === useVersions.getState().hovered;
        if (path && selected?.changed) {
          const pictures = await pictureSources.get(path);
          // The scrub encode can rebase timestamps. Align its first frame to a constant-rate
          // file's first picture. Otherwise keep the ordinal from the original's sample index.
          if (pictures && !("ticks" in pictures.index) && !original?.cached) {
            const offset =
              pictureTime(pictures, seconds) - secondsOf(pictures.index.origin);
            const proxy = await auditionStandIn(
              path,
              (proxy) => proxy.indexAt(proxy.firstTime + offset),
              selected.warming,
              needed,
            );
            return {
              ...proxy,
              intrinsic: original?.intrinsic ?? proxy.intrinsic,
            };
          }
        }
        const { found, index, intrinsic, cached } = await requested;
        if (path && selected && !cached) {
          const proxy = await auditionStandIn(
            path,
            () => index,
            selected.warming,
            needed,
          );
          return { ...proxy, intrinsic };
        }
        const proxy = !moving && !playing && !cached ? found?.proxy : null;
        if (proxy) {
          hasStandIn = true;
          return {
            intrinsic,
            rotation: proxy.rotation,
            frame: await proxy.frame(index),
          };
        }
        const picture = await exact;
        return { ...picture, frame: picture.frame.clone() };
      };
      return { exact, standIn };
    });
    const paint = async (frames: Picture[], standIn: boolean) => {
      const target = compositor;
      const canPaint = () =>
        plan === drawingPlan && !closing.signal.aborted && target.isAvailable();
      if (!canPaint()) return;
      const baked = await textures;
      const effects = adjustments ? await adjustments : undefined;
      if (!canPaint()) return;
      if ("error" in baked) throw baked.error;
      if (effects && "error" in effects) throw effects.error;
      const matteFrame = await matteFrames;
      if (!canPaint()) return;
      const currentAudition = useVersions.getState();
      if (
        auditionAtDraw.open !== currentAudition.open ||
        auditionAtDraw.hovered !== currentAudition.hovered
      )
        return;
      // An opaque full-frame shot without its own grade needs no intermediate copy.
      const single = effects?.[0];
      const fused =
        single?.after === 1 &&
        lowerCount === 1 &&
        effects!.length === 1 &&
        !baked[0] &&
        coversFrame(shown.pictures[0]!);
      const drawn = frames.map(({ frame, rotation, intrinsic }, at) => {
        const matte = matteFrame[at];
        // The proxy is stored upright; a phone's file may be stored turned.
        return matte === empty
          ? null
          : placed(
              layers![at]!,
              frame,
              rotation,
              intrinsic,
              fused ? single.grade : baked[at]!,
              matte ?? null,
            );
      });
      const keep = (list: typeof drawn) =>
        list.filter((layer) => layer !== null);
      await target.draw(
        keep(drawn.slice(0, lowerCount)),
        drawingPlan.background ?? "#ffffff",
        drawingPlan.width,
        drawingPlan.height,
        fused ? undefined : effects,
      );
      const upper = keep(drawn.slice(lowerCount));
      if (upper.length || aboveDrawn) {
        aboveCompositor ??= createCompositor(aboveCanvas);
        await aboveCompositor.draw(
          upper,
          null,
          drawingPlan.width,
          drawingPlan.height,
        );
        aboveDrawn = upper.length > 0;
        aboveCanvas.hidden = !aboveDrawn;
      }
      // HyperFrames keeps the picture if this upload lost its drawing context.
      if (!canPaint()) return;
      canvas.dataset.standin = String(standIn);
      canvas.dataset.frame = String(frame);
      stopped = null;
      if (!usePipeline.getState().active)
        usePipeline.setState({ active: true });
    };
    const settle = async <T extends Picture>(requests: Promise<T>[]) => {
      const frames = await Promise.allSettled(requests);
      const held = frames.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const failed = frames.find((result) => result.status === "rejected");
      if (failed) {
        for (const { frame } of held) frame.close();
        throw failed.reason;
      }
      return held;
    };
    const exact = settle(pictures.map(({ exact }) => exact)).finally(() => {
      arrived = true;
    });
    let provisional: Promise<void> | undefined;
    if (alternate?.decoder || alternate?.changed || (!moving && !playing)) {
      // Paint a scrub-proxy picture if it arrives first. A missing or late proxy can't delay
      // an exact frame, and either path closes the frames it owns.
      void settle(pictures.map(({ standIn }) => standIn())).then(
        async (ready) => {
          try {
            if (!arrived && (alternate || !wanted)) {
              provisional = paint(ready, true).catch(() => {});
              await provisional;
            }
          } finally {
            for (const { frame } of ready) frame.close();
          }
        },
        () => {},
      );
    }
    const closeMattes = () =>
      void matteFrames.then((all) => {
        for (const matte of all) if (matte && matte !== empty) matte.close();
      });
    const frames = await exact.catch((error: unknown) => {
      closeMattes();
      throw error;
    });
    try {
      if (provisional) await provisional;
      if (hasStandIn && !alternate && wanted) return;
      await paint(frames, false);
    } finally {
      for (const { frame } of frames) frame.close();
      closeMattes();
    }
    if (plan !== drawingPlan || closing.signal.aborted) return;
    for (const { found, lane, index } of frames) {
      if (moving) continue;
      if (found) found.playing = lane;
      // A parked frame was flushed out of the decoder, which ends its run. Decode on from it now,
      // so Play and repeated keyboard trims start from frames in hand, not from the keyframe.
      lane.prefetch(index + 1, index + lane.room(8));
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
        const key = grades.identify(
          layer.clip.grade,
          view.composition,
          useWorkspace.getState().fileChanges,
        );
        if (key) void grades.get(key).catch(() => {});
      }
      const src = layer.clip.src!;
      // At rest, only the next opening of each file: the spare lane holds one.
      if (count === PREPARED && sources.has(src)) continue;
      sources.add(src);
      void source(src)
        .then((found) => {
          const index = indexAt(found, layer.time, layer.source());
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
    // Every root-level timeline plays through it; a scene in a folder stays with HyperFrames.
    if (!isTimelinePath(view.composition)) {
      plan = null;
      return stop("only a timeline plays through it, not a scene");
    }
    let response: ReturnType<typeof PipelineResponseSchema.parse>;
    try {
      const request = await fetch(
        `/api/cutroom/projects/${encodeURIComponent(projectId)}/pipeline?composition=${encodeURIComponent(view.composition)}`,
        { signal: closing.signal },
      );
      response = PipelineResponseSchema.parse(await request.json());
    } catch (error) {
      if (!isCurrent()) return;
      plan = null;
      return stop(error instanceof Error ? error.message : String(error));
    }
    if (!isCurrent()) return;
    const { plan: next, colours, sourceRefusals: refusals } = response;
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
    sourceRefusals = refusals;
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
    useMatteView.subscribe(() => void draw()),
    // A matte that becomes ready, or goes, changes the picture; progress alone does not.
    useMattes.subscribe((state, previous) => {
      if (
        JSON.stringify(state.status?.mattes) !==
        JSON.stringify(previous.status?.mattes)
      )
        void draw();
    }),
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
      aboveCompositor?.dispose();
      aboveCanvas.hidden = true;
      grades.dispose();
      for (const stop of unsubscribe) stop();
      usePipeline.setState({ active: false });
      for (const decoder of mattes.values())
        void decoder.then((lane) => lane.close()).catch(() => {});
      for (const found of sources.values())
        void found.then(({ lanes, proxy }) => {
          for (const lane of lanes) lane.close();
          proxy?.close();
        });
    },
  };
}
