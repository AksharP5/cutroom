import { create } from "zustand";
import { reportEditorError, showToast } from "../workspace";
import { audioLevels } from "./levels";
import {
  CompositionDiagnosticsSchema,
  ClipBoxSchema,
  PositionWarningSchema,
  TextWarningSchema,
  PositionFoldSchema,
  PreviewLevelsSchema,
  PreviewFrameStatusSchema,
  PlaybackClockSchema,
  PreviewReplySchema,
  PreviewTimingSchema,
  PreviewUnloadedSchema,
  RampAudioFailedSchema,
  RuntimeStateSchema,
  TrackGainPreviewSchema,
} from "../../shared/preview";
import {
  relativeTransformStyle,
  transformStyle,
} from "../../shared/timeline/transform";
import type {
  ClipTransform,
  TransformStyle,
} from "../../shared/timeline/transform";
import type {
  PositionWarning,
  CompositionDiagnostic,
  PictureBox,
  PictureHit,
  PlaybackClock,
  ShownClip,
  PreviewState,
  TrackGainPreview,
} from "../../shared/preview";
import { z } from "zod";
import type { RuntimePlayer } from "./transport";
import { useTransport } from "./transport";
import { usePipeline } from "../pipeline/setting";
import { frameTime } from "../../shared/timeline/apply";
import { editPicture, followEditPicture } from "./editFrame";
import type { EditPicture } from "./editFrame";
import { seekQueue } from "./seekQueue";
import { writeGrade } from "../../shared/timeline/grade";
import type { Grade } from "../../shared/timeline/grade";

export const usePositionWarning = create<{
  warning: {
    clipId: string;
    time: number;
    properties: PositionWarning["overridden"];
  } | null;
}>(() => ({ warning: null }));
export const useTextWarning = create<{
  warning: { clipId: string; time: number; text: string } | null;
}>(() => ({ warning: null }));
const PreviewCopiesSchema = z.object({
  source: z.literal("hf-preview"),
  type: z.literal("preview-copies"),
  copies: z
    .object({
      total: z.number(),
      ready: z.number(),
      failed: z.number(),
      progress: z.number(),
    })
    .nullable(),
});
type PreviewCopies = z.infer<typeof PreviewCopiesSchema>["copies"];
/**
 * The editing proxies the shown preview waits for, as HyperFrames' runtime counts them: videos
 * this browser cannot decode play from a proxy the server makes in the background.
 */
export const usePreparing = create<{ copies: PreviewCopies }>(() => ({
  copies: null,
}));
let preparingSource: HTMLIFrameElement | null = null;
let observedClip: string | null = null;
let observedText: string | null = null;
let observedTransform: TransformStyle | null = null;
let warningSource: HTMLIFrameElement | null = null;
const observers = new Set<(clipId: string | null) => void>();
export function observePosition(
  clipId: string | null,
  text: string | null = null,
  transform: ClipTransform | null = null,
) {
  observedClip = clipId;
  observedText = text;
  observedTransform = transform && transformStyle(transform);
  useTextWarning.setState({ warning: null });
  usePositionWarning.setState({ warning: null });
  if (pictureBox.current()?.clipId !== clipId) pictureBox.publish(null);
  for (const observe of observers) observe(clipId);
}

type ShownBox = { clipId: string; box: PictureBox | null };
let shownBox: ShownBox | null = null;
const boxListeners = new Set<() => void>();
/**
 * Where the observed clip is on the picture, in composition pixels. Boxes follow playback, so
 * they never enter React; only the promoted preview may publish them.
 */
export const pictureBox = {
  current: () => shownBox,
  publish(next: ShownBox | null) {
    shownBox = next;
    for (const listener of boxListeners) listener();
  },
  subscribe(listener: () => void) {
    boxListeners.add(listener);
    return () => {
      boxListeners.delete(listener);
    };
  },
};

let pictureTarget: {
  hit(x: number, y: number): Promise<PictureHit[]>;
  boxes(): Promise<ShownClip[]>;
  audition(version: number): void;
} | null = null;
/** The clips under a point of the shown picture, topmost first, in composition pixels. */
export const hitPicture = (x: number, y: number) =>
  pictureTarget?.hit(x, y) ?? Promise.resolve([]);
/** Every clip drawn on the shown picture, with its box in composition pixels. */
export const shownClips = () => pictureTarget?.boxes() ?? Promise.resolve([]);
/**
 * Shows one of a clip's versions in the shown picture, when its document carries them all
 * (see `versions.ts`). Any other document ignores the message.
 */
export const auditionPicture = (version: number) =>
  pictureTarget?.audition(version);

/** A move under way on the picture, which the inspector's Position fields show until it ends. */
export const usePictureMove = create<{
  move: { clipId: string; x: number; y: number } | null;
}>(() => ({ move: null }));

/** A scale under way on the picture's corner handles, which the inspector's Scale fields show. */
export const usePictureScale = create<{
  scale: { clipId: string; scaleX: number; scaleY: number } | null;
}>(() => ({ scale: null }));

/** A text clip whose words the inspector should take the keyboard for, asked from the picture. */
export const useTextEdit = create<{ clipId: string | null }>(() => ({
  clipId: null,
}));

type PositionDraft = { clipId: string; x: number | null; y: number | null };
const positionTargets = new Set<(draft: PositionDraft) => void>();
let positionDraft: PositionDraft | null = null;
/** Drafts go only to preview documents, never through timeline state or the server. */
export function previewPosition(
  clipId: string,
  x: number | null,
  y: number | null,
) {
  positionDraft = { clipId, x, y };
  for (const target of positionTargets) target(positionDraft);
}

export function cancelPositionPreview(clipId: string, x: number, y: number) {
  previewPosition(clipId, x, y);
  positionDraft = null;
}

export async function commitPositionPreview(commit: () => Promise<boolean>) {
  const draft = positionDraft;
  const accepted = await commit();
  // An earlier commit must never clear a subsequent gesture's draft.
  if (positionDraft !== draft) return;
  if (!accepted && draft) previewPosition(draft.clipId, null, null);
  positionDraft = null;
}

type TransformDraft = {
  clipId: string;
  style: TransformStyle | null;
  onGsap: TransformStyle;
};
const transformTargets = new Set<(draft: TransformDraft) => void>();
let transformDraft: TransformDraft | null = null;
/** A Scale, Rotation or Crop draft; like Position, it goes only to preview documents. */
export function previewTransform(
  clipId: string,
  draft: ClipTransform | null,
  saved: ClipTransform,
) {
  transformDraft = {
    clipId,
    style: draft && transformStyle(draft),
    onGsap: relativeTransformStyle(draft ?? saved, saved),
  };
  for (const target of transformTargets) target(transformDraft);
}

export function cancelTransformPreview(clipId: string, saved: ClipTransform) {
  previewTransform(clipId, null, saved);
  transformDraft = null;
}

export async function commitTransformPreview(
  saved: ClipTransform,
  commit: () => Promise<boolean>,
) {
  const draft = transformDraft;
  const accepted = await commit();
  // An earlier commit must never clear a subsequent gesture's draft.
  if (transformDraft !== draft) return;
  if (!accepted && draft) previewTransform(draft.clipId, null, saved);
  transformDraft = null;
}

/** Inline values that draw a keyframed property's draft, by CSS longhand. */
export type KeyframeStyle = Record<string, string>;
type KeyframeDraft = { clipId: string; style: KeyframeStyle | null };
const keyframeTargets = new Set<(draft: KeyframeDraft) => void>();
let keyframeDraft: KeyframeDraft | null = null;
/** A keyframed property's value while it is scrubbed or typed; null restores the saved animation. */
export function previewKeyframe(clipId: string, style: KeyframeStyle | null) {
  keyframeDraft = { clipId, style };
  for (const target of keyframeTargets) target(keyframeDraft);
}

export async function commitKeyframePreview(commit: () => Promise<boolean>) {
  const draft = keyframeDraft;
  const accepted = await commit();
  // The saved document replaces the drafted one; an earlier commit never clears a later draft.
  if (keyframeDraft !== draft) return;
  if (!accepted && draft) previewKeyframe(draft.clipId, null);
  keyframeDraft = null;
}

/**
 * Region CSS drawn over the saved stylesheet while a box is dragged: a blur or highlight's new
 * look, or every zoom set aside so the frame can be aimed at. Null draws what is saved.
 */
type RegionDraft = { css: string | null; seek: boolean };
const regionTargets = new Set<(draft: RegionDraft) => void>();
let regionDraft: RegionDraft = { css: null, seek: false };
/** `seek` redraws the frame, for a change to which zooms run. */
export function previewRegion(css: string | null, seek = false) {
  if (css === regionDraft.css) return;
  regionDraft = { css, seek };
  for (const target of regionTargets) target(regionDraft);
}

/** The current adjustment while a grade control is dragged or stepped. */
type GradeDraft = {
  clipId: string;
  grade: Grade | null;
  restore: boolean;
};
const gradeTargets = new Set<(draft: GradeDraft) => void>();
export const usePreviewGrade = create<{ draft: GradeDraft | null }>(() => ({
  draft: null,
}));
const updateGradeDraft = (draft: GradeDraft | null) =>
  usePreviewGrade.setState({ draft });
/** Like Position, a grade draft goes only to preview documents, never through the timeline. */
export function previewGrade(clipId: string, grade: Grade | null) {
  const draft = { clipId, grade, restore: false };
  updateGradeDraft(draft);
  for (const target of gradeTargets) target(draft);
}

export function cancelGradePreview(clipId: string) {
  const draft = { clipId, grade: null, restore: true };
  for (const target of gradeTargets) target(draft);
  updateGradeDraft(null);
}

export async function commitGradePreview(commit: () => Promise<boolean>) {
  const { draft } = usePreviewGrade.getState();
  const accepted = await commit();
  // The saved document replaces the drafted one; an earlier commit never clears a later draft.
  if (usePreviewGrade.getState().draft !== draft) return;
  if (!accepted && draft) cancelGradePreview(draft.clipId);
  updateGradeDraft(null);
}

export type MixScope = { projectId: string; composition: string };
/** Main drafts trim its saved gain. Track and bus drafts use absolute gain. */
type MixDraft = MixScope & { strip: string; volume: number };
const mixTargets = new Set<(draft: MixDraft) => void>();
/** Heard in the playing and incoming previews of the composition being edited. */
export function previewMix(scope: MixScope, strip: string, volume: number) {
  const draft = { ...scope, strip, volume };
  for (const target of mixTargets) target(draft);
}

/** Shift+D shows every clip ungraded in the viewer, as Resolve's bypass does, until pressed again. */
export const useGradeBypass = create<{ bypass: boolean }>(() => ({
  bypass: false,
}));

/** Owns one frame's message requests and cached clock. It never reads the composition's DOM. */
export function connectPreview(
  frame: HTMLIFrameElement,
  {
    onUnload,
    onRampFailure,
    mixScope,
  }: { onUnload(): void; onRampFailure(): void; mixScope: MixScope },
) {
  let state: PreviewState = {
    ready: false,
    root: false,
    error: null,
    width: 1920,
    height: 1080,
    fps: null,
    time: 0,
    playing: false,
  };
  const closing = new AbortController();
  let active = false;
  let frameError: string | null = null;
  const reportFrameError = (error: string | null) => {
    if (frameError === error) return;
    frameError = error;
    if (warningSource === frame) reportEditorError("previewFrame", error);
  };
  let timingRevision: string | undefined;
  let timingAllowed = false;
  let diagnostics: CompositionDiagnostic[] = [];
  let diagnosticsKey = "";
  let dismissDiagnostics = () => {};
  const showDiagnostics = () => {
    if (!active) return;
    const key = JSON.stringify(diagnostics);
    if (key === diagnosticsKey) return;
    diagnosticsKey = key;
    dismissDiagnostics();
    dismissDiagnostics = diagnostics.length
      ? showToast(
          diagnostics
            .map(({ file, message }) => `${file}: ${message}`)
            .join("\n"),
          undefined,
          { priority: "background" },
        )
      : () => {};
  };
  let clock: PlaybackClock | null = null;
  let playbackAnchor: PlaybackClock | null = null;
  let buffering = false;
  /** Runtime messages queued before this command must not undo the local playback intent. */
  let playbackRequest: string | null = null;
  type Reply = z.infer<typeof PreviewReplySchema>;
  const pending = new Map<
    string,
    { resolve(reply: Reply): void; reject(error: Error): void; timer: number }
  >();
  let copies: PreviewCopies = null;
  const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== frame.contentWindow) return;
    const preparing = PreviewCopiesSchema.safeParse(event.data);
    if (preparing.success) {
      copies = preparing.data.copies;
      // The first document says so before it can show anything; later ones once they show.
      if (preparingSource === frame || preparingSource === null)
        usePreparing.setState({ copies });
      return;
    }
    if (
      event.data &&
      typeof event.data === "object" &&
      "type" in event.data &&
      event.data.type === "frame-status"
    ) {
      const status = PreviewFrameStatusSchema.safeParse(event.data);
      if (status.success) reportFrameError(status.data.error);
      return;
    }
    if (
      event.data &&
      typeof event.data === "object" &&
      "type" in event.data &&
      event.data.type === "ramp-audio-failed" &&
      RampAudioFailedSchema.safeParse(event.data).success
    ) {
      onRampFailure();
      return;
    }
    if (active) {
      const playback = PlaybackClockSchema.safeParse(event.data);
      if (playback.success) {
        if (playbackRequest === null) clock = playback.data;
        return;
      }
      const levels = PreviewLevelsSchema.safeParse(event.data);
      if (levels.success) {
        audioLevels.publish(levels.data);
        return;
      }
      const warning = PositionWarningSchema.safeParse(event.data);
      if (warning.success) {
        const { clipId, time, overridden } = warning.data;
        if (frame === warningSource && clipId === observedClip)
          usePositionWarning.setState({
            warning: overridden.length
              ? { clipId, time, properties: overridden }
              : null,
          });
        return;
      }
      const textWarning = TextWarningSchema.safeParse(event.data);
      if (textWarning.success) {
        const { clipId, time, text, overridden } = textWarning.data;
        if (
          frame === warningSource &&
          clipId === observedClip &&
          text === observedText
        )
          useTextWarning.setState({
            warning: overridden ? { clipId, time, text } : null,
          });
        return;
      }
      const box = ClipBoxSchema.safeParse(event.data);
      if (box.success) {
        if (frame === warningSource && box.data.clipId === observedClip)
          pictureBox.publish({ clipId: observedClip, box: box.data.box });
        return;
      }
      const fold = PositionFoldSchema.safeParse(event.data);
      if (fold.success && frame === warningSource) {
        send("position-fold", { hfId: fold.data.properties.hfId });
        return;
      }
    }
    if (
      event.data &&
      typeof event.data === "object" &&
      "type" in event.data &&
      event.data.type === "composition-errors"
    ) {
      const errors = CompositionDiagnosticsSchema.safeParse(event.data);
      if (errors.success) {
        diagnostics = errors.data.diagnostics;
        showDiagnostics();
      }
      return;
    }
    const runtime = RuntimeStateSchema.safeParse(event.data);
    if (runtime.success) {
      if (playbackRequest !== null) return;
      state.time = runtime.data.currentTime;
      state.playing = runtime.data.isPlaying;
      buffering = runtime.data.buffering;
      return;
    }
    if (PreviewUnloadedSchema.safeParse(event.data).success) {
      dispose();
      onUnload();
      return;
    }
    const parsed = PreviewReplySchema.safeParse(event.data);
    if (!parsed.success) return;
    const reply = parsed.data;
    timingRevision = reply.timingRevision;
    const transportReply =
      playbackRequest !== null && reply.id === playbackRequest;
    if (playbackRequest === null || transportReply) {
      state = reply.state;
      if (transportReply) {
        frame.toggleAttribute("data-seek-pending", Boolean(reply.error));
        if (reply.error) reportFrameError(reply.error);
      }
      playbackRequest = null;
    }
    if (reply.diagnostics) {
      diagnostics = reply.diagnostics;
      showDiagnostics();
    }
    const id = reply.id;
    const request = id ? pending.get(id) : undefined;
    if (!id || !request) {
      if (active && reply.error && !transportReply)
        reportEditorError("viewer", new Error(reply.error));
      return;
    }
    pending.delete(id);
    clearTimeout(request.timer);
    if (reply.error) request.reject(new Error(reply.error));
    else request.resolve(reply);
  };
  window.addEventListener("message", receive);
  const send = (action: string, payload: object = {}) => {
    const id = crypto.randomUUID();
    // A WindowProxy survives navigation. A retired connection must never command
    // the new document through that same window.
    if (!closing.signal.aborted)
      frame.contentWindow?.postMessage(
        { source: "cutroom-viewer", id, action, ...payload },
        "*",
      );
    return id;
  };
  const request = (
    action: string,
    payload: object = {},
    signal = closing.signal,
    sent?: (id: string) => void,
  ) =>
    new Promise<Reply>((resolve, reject) => {
      closing.signal.throwIfAborted();
      signal.throwIfAborted();
      const id = send(action, payload);
      sent?.(id);
      const finish = () => {
        clearTimeout(timer);
        pending.delete(id);
        signal.removeEventListener("abort", cancel);
      };
      const cancel = () => {
        finish();
        reject(signal.reason);
      };
      const timer = window.setTimeout(() => {
        finish();
        const message = "The preview did not draw the frame in time.";
        if (id === playbackRequest) reportFrameError(message);
        reject(new Error(message));
      }, 10_000);
      signal.addEventListener("abort", cancel, { once: true });
      pending.set(id, {
        resolve: (reply) => {
          finish();
          resolve(reply);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
        timer,
      });
    });
  // A moving playhead waits for each picture before asking for the next, so a decode is
  // never abandoned for a newer one before it shows anything. The preview paints on its
  // own, so the next seek starts as soon as the last one shows rather than at our paint.
  const moving = seekQueue<number>(
    async (time) => {
      await request("seek", { time, scrub: true }, closing.signal, (id) => {
        frame.setAttribute("data-seek-pending", "");
        playbackRequest = id;
      });
    },
    // Transport replies and timeouts report only for the latest request above.
    () => {},
    (start) => {
      queueMicrotask(() => start(performance.now()));
      return 1;
    },
    () => {},
  );
  const player: RuntimePlayer = {
    play: () => {
      moving.clear();
      clock = null;
      playbackAnchor = null;
      state.playing = true;
      playbackRequest = send("play");
    },
    pause: () => {
      moving.clear();
      state.playing = false;
      frame.setAttribute("data-seek-pending", "");
      playbackRequest = send("pause");
    },
    seek: (time, scrub) => {
      clock = null;
      playbackAnchor = null;
      state.time = time;
      frame.setAttribute("data-seek-pending", "");
      if (scrub) return moving.push(time);
      moving.clear();
      playbackRequest = send("seek", { time });
    },
    time: (at) => {
      // At a display refresh, draw from the preview's continuous clock.
      // Posted frame numbers can arrive on either side of that refresh.
      if (
        at === undefined ||
        !clock ||
        !state.playing ||
        buffering ||
        !usePipeline.getState().active ||
        Math.abs(performance.timeOrigin + at - clock.at) >= 100
      ) {
        playbackAnchor = null;
        return state.time;
      }
      // Keep the last stable sample through sub-frame jitter. Follow a
      // real clock correction so the canvas stays in sync with the layers.
      if (
        !playbackAnchor ||
        Math.abs(
          clock.time -
            playbackAnchor.time -
            (clock.at - playbackAnchor.at) / 1000,
        ) > 0.004
      )
        playbackAnchor = clock;
      return (
        playbackAnchor.time +
        Math.max(0, performance.timeOrigin + at - playbackAnchor.at) / 1000
      );
    },
    clock: () => clock,
    playing: () => state.playing,
    setMuted: (muted) => {
      send("mute", { muted });
    },
  };
  const position = (draft: PositionDraft) => {
    send("position", draft);
  };
  const transform = (draft: TransformDraft) => {
    send("transform", draft);
  };
  const keyframe = (draft: KeyframeDraft) => {
    send("keyframe", draft);
  };
  const region = (draft: RegionDraft) => {
    send("region", draft);
  };
  const grade = (draft: GradeDraft) => {
    const { grade, ...target } = draft;
    send("grade", { ...target, attribute: writeGrade(grade) });
  };
  const bypass = ({ bypass }: { bypass: boolean }) => {
    send("grade-bypass", { bypass });
  };
  const mixDraft = ({ projectId, composition, strip, volume }: MixDraft) => {
    if (
      projectId === mixScope.projectId &&
      composition === mixScope.composition
    )
      send("mix-draft", { strip, volume });
  };
  mixTargets.add(mixDraft);
  let unwatchStripMetering = () => {};
  let unfollowBypass = () => {};
  const observe = (clipId: string | null) =>
    send("observe-position", {
      clipId,
      text: observedText,
      transform: observedTransform,
    });
  const picture = {
    hit: async (x: number, y: number) =>
      (await request("hit", { x, y })).hits ?? [],
    boxes: async () => (await request("boxes")).boxes ?? [],
    audition: (version: number) =>
      frame.contentWindow?.postMessage(
        { source: "cutroom-audition", version },
        "*",
      ),
  };
  const edit = seekQueue<EditPicture | null>(
    async (picture) => {
      const { frame, fps } = useTransport.getState();
      await request(
        "seek",
        picture
          ? { time: picture.time, edit: picture.frames }
          : { time: frameTime(frame, fps) },
      );
    },
    (error) => {
      if (!closing.signal.aborted)
        reportFrameError(
          error instanceof Error ? error.message : String(error),
        );
    },
  );
  let unfollowEdit = () => {};
  const dispose = () => {
    dismissDiagnostics();
    unfollowEdit();
    edit.dispose();
    moving.dispose();
    if (positionTargets.delete(position) && !positionTargets.size)
      positionDraft = null;
    if (transformTargets.delete(transform) && !transformTargets.size)
      transformDraft = null;
    if (keyframeTargets.delete(keyframe) && !keyframeTargets.size)
      keyframeDraft = null;
    regionTargets.delete(region);
    mixTargets.delete(mixDraft);
    if (gradeTargets.delete(grade) && !gradeTargets.size)
      updateGradeDraft(null);
    unfollowBypass();
    observers.delete(observe);
    if (warningSource === frame) {
      warningSource = null;
      reportEditorError("previewFrame", null);
      usePositionWarning.setState({ warning: null });
      useTextWarning.setState({ warning: null });
      pictureBox.publish(null);
    }
    if (pictureTarget === picture) pictureTarget = null;
    if (preparingSource === frame) {
      preparingSource = null;
      usePreparing.setState({ copies: null });
    }
    unwatchStripMetering();
    send("meter", { enabled: false });
    closing.abort();
    if (active) audioLevels.publish({ l: 0, r: 0, playing: false });
    active = false;
    window.removeEventListener("message", receive);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(closing.signal.reason);
    }
    pending.clear();
  };
  /** Applies a snapshot that differs from this document only in Cutroom's track gains. */
  const mix = async (snapshot: TrackGainPreview, signal = closing.signal) => {
    if (
      !state.mixSignature ||
      snapshot.signature !== state.mixSignature ||
      snapshot.compositions.some((path) => path !== "index.html")
    )
      return false;
    return (
      (
        await request(
          "track-gains",
          {
            ...snapshot,
            positionDraftClipId:
              positionDraft?.clipId ?? transformDraft?.clipId ?? null,
          },
          signal,
        )
      ).mixApplied === true
    );
  };
  return {
    player,
    mix,
    /** Whether the footage pipeline draws root videos beneath this document, and which. */
    pipeline: (
      active: boolean,
      drawn: readonly string[],
      native: readonly string[],
    ) => {
      frame.setAttribute("data-seek-pending", "");
      playbackRequest = send("pipeline", { active, drawn, native });
    },
    signal: closing.signal,
    async activate() {
      positionTargets.add(position);
      transformTargets.add(transform);
      keyframeTargets.add(keyframe);
      regionTargets.add(region);
      // A region draft outlives saves: a new document takes it before it is shown.
      if (regionDraft.css) region({ ...regionDraft, seek: true });
      gradeTargets.add(grade);
      bypass(useGradeBypass.getState());
      unfollowBypass = useGradeBypass.subscribe(bypass);
      // Keep both documents following the gesture until the new one has painted its latest
      // draft. Promotion runs immediately after this resolves, before another event can edit it.
      let shown: PositionDraft | null;
      let shownTransform: TransformDraft | null;
      let shownKeyframe: KeyframeDraft | null;
      let shownGrade: GradeDraft | null;
      do {
        shown = positionDraft;
        shownTransform = transformDraft;
        shownKeyframe = keyframeDraft;
        shownGrade = usePreviewGrade.getState().draft;
        if (shown) position(shown);
        if (shownTransform) transform(shownTransform);
        if (shownKeyframe) keyframe(shownKeyframe);
        if (shownGrade) grade(shownGrade);
        await request("paint");
        closing.signal.throwIfAborted();
      } while (
        shown !== positionDraft ||
        shownTransform !== transformDraft ||
        shownKeyframe !== keyframeDraft ||
        shownGrade !== usePreviewGrade.getState().draft
      );
      // A candidate follows a drag already under way before it can replace the picture.
      let editing: EditPicture | null;
      let hadEdit = false;
      do {
        editing = editPicture();
        if (editing)
          await request("seek", { time: editing.time, edit: editing.frames });
        else if (hadEdit) {
          const { frame, fps } = useTransport.getState();
          await request("seek", { time: frameTime(frame, fps) });
        }
        hadEdit = editing !== null;
        closing.signal.throwIfAborted();
        if (editing !== editPicture())
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
      } while (editing !== editPicture());
      unfollowEdit = followEditPicture((picture) => {
        if (!picture) send("cancel-edit");
        edit.push(picture);
      });
      active = true;
      preparingSource = frame;
      usePreparing.setState({ copies });
      showDiagnostics();
    },
    /** Selection belongs to the shown document, including a retained picture after a superseded handoff. */
    present() {
      if (closing.signal.aborted) return;
      if (warningSource !== frame)
        reportEditorError("previewFrame", frameError);
      warningSource = frame;
      pictureTarget = picture;
      observers.add(observe);
      observe(observedClip);
      unwatchStripMetering();
      unwatchStripMetering = audioLevels.watchStripMetering((strips) =>
        send("meter", { enabled: true, strips }),
      );
    },
    get state() {
      return state;
    },
    inspect: async () => (await request("inspect")).state,
    checkRampAudio: async () => void (await request("check-ramp")),
    async waitForRamp() {
      const response = await fetch(`${frame.src}&cutroom-ramp=1`, {
        signal: closing.signal,
      });
      return (
        response.ok &&
        z.object({ ready: z.boolean() }).parse(await response.json()).ready
      );
    },
    painted: async () => void (await request("paint")),
    get hasTimingHint() {
      return Boolean(timingRevision);
    },
    async authorizeTiming() {
      if (!timingRevision) return;
      const response = await fetch(`${frame.src}&cutroom-status=1`, {
        signal: closing.signal,
      });
      if (response.ok)
        timingAllowed = z
          .object({ allowed: z.boolean() })
          .parse(await response.json()).allowed;
    },
    get timingAllowed() {
      return timingAllowed;
    },
    async updateTiming(
      time: number,
      signal: AbortSignal,
      latest: () => boolean,
      /** Called as the page starts the update; from then on it runs to its end. */
      started: () => void,
    ) {
      if (!timingAllowed || !timingRevision)
        throw new Error("The preview has no timing revision.");
      const response = await fetch(`${frame.src}&cutroom-timing=1`, { signal });
      if (!response.ok)
        throw new Error("The saved preview timing is unavailable.");
      const snapshot = z
        .object({
          version: z.string(),
          timing: PreviewTimingSchema.nullable(),
          mix: TrackGainPreviewSchema,
          live: z.boolean(),
        })
        .parse(await response.json());
      signal.throwIfAborted();
      if (!latest()) return false;
      if (!snapshot.live) timingAllowed = false;
      // A fader change needs no seek or repaint.
      if (snapshot.mix.signature === state.mixSignature) {
        if (await mix(snapshot.mix, signal)) return true;
        throw new Error("The preview did not accept the track gains.");
      }
      // Availability of the new snapshot does not change approval of this loaded document.
      if (!snapshot.live || !snapshot.timing)
        throw new Error("This preview requires a reload.");
      const reply = await request(
        "timing",
        {
          timing: snapshot.timing,
          mixSignature: snapshot.mix.signature,
          gains: snapshot.mix.gains,
          expectedRevision: timingRevision,
          time,
        },
        signal,
        started,
      );
      signal.throwIfAborted();
      if (reply.timingRevision !== snapshot.timing.revision)
        throw new Error(
          "The preview did not acknowledge the saved timing revision.",
        );
      return true;
    },
    dispose,
  };
}
