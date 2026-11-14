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
  PlaybackClockSchema,
  PreviewReplySchema,
  PreviewTimingSchema,
  PreviewUnloadedSchema,
  RuntimeStateSchema,
} from "../../shared/preview";
import type {
  CompositionDiagnostic,
  PictureBox,
  PictureHit,
  PlaybackClock,
  PreviewState,
} from "../../shared/preview";
import { z } from "zod";
import type { RuntimePlayer } from "./transport";
import { useTransport } from "./transport";
import { frameTime } from "../../shared/timeline/apply";
import { editPicture, followEditPicture } from "./editFrame";
import type { EditPicture } from "./editFrame";
import { seekQueue } from "./seekQueue";

export const usePositionWarning = create<{
  warning: { clipId: string; time: number } | null;
}>(() => ({ warning: null }));
export const useTextWarning = create<{
  warning: { clipId: string; time: number; text: string } | null;
}>(() => ({ warning: null }));
let observedClip: string | null = null;
let observedText: string | null = null;
let warningSource: HTMLIFrameElement | null = null;
const observers = new Set<(clipId: string | null) => void>();
export function observePosition(
  clipId: string | null,
  text: string | null = null,
) {
  observedClip = clipId;
  observedText = text;
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

let hitTarget: ((x: number, y: number) => Promise<PictureHit[]>) | null = null;
/** The clips under a point of the shown picture, topmost first, in composition pixels. */
export const hitPicture = (x: number, y: number) =>
  hitTarget?.(x, y) ?? Promise.resolve([]);

/** A move under way on the picture, which the inspector's Position fields show until it ends. */
export const usePictureMove = create<{
  move: { clipId: string; x: number; y: number } | null;
}>(() => ({ move: null }));

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

/** Owns one frame's message requests and cached clock. It never reads the composition's DOM. */
export function connectPreview(frame: HTMLIFrameElement, onUnload: () => void) {
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
  /** Runtime messages queued before this command must not undo the local playback intent. */
  let playbackRequest: string | null = null;
  type Reply = z.infer<typeof PreviewReplySchema>;
  const pending = new Map<
    string,
    { resolve(reply: Reply): void; reject(error: Error): void; timer: number }
  >();
  const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== frame.contentWindow) return;
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
            warning: overridden ? { clipId, time } : null,
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
    if (playbackRequest === null || reply.id === playbackRequest) {
      state = reply.state;
      playbackRequest = null;
    }
    if (reply.diagnostics) {
      diagnostics = reply.diagnostics;
      showDiagnostics();
    }
    const id = reply.id;
    const request = id ? pending.get(id) : undefined;
    if (!id || !request) {
      if (active && reply.error)
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
  ) =>
    new Promise<Reply>((resolve, reject) => {
      closing.signal.throwIfAborted();
      signal.throwIfAborted();
      const id = send(action, payload);
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
        reject(new Error("The preview did not draw the frame in time."));
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
  const player: RuntimePlayer = {
    play: () => {
      clock = null;
      state.playing = true;
      playbackRequest = send("play");
    },
    pause: () => {
      state.playing = false;
      playbackRequest = send("pause");
    },
    seek: (time) => {
      clock = null;
      state.time = time;
      playbackRequest = send("seek", { time });
    },
    time: () => state.time,
    clock: () => clock,
    playing: () => state.playing,
    setMuted: (muted) => {
      send("mute", { muted });
    },
  };
  const position = (draft: PositionDraft) => {
    send("position", draft);
  };
  const observe = (clipId: string | null) =>
    send("observe-position", { clipId, text: observedText });
  const hit = async (x: number, y: number) =>
    (await request("hit", { x, y })).hits ?? [];
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
      if (!closing.signal.aborted) reportEditorError("viewer", error);
    },
  );
  let unfollowEdit = () => {};
  const dispose = () => {
    dismissDiagnostics();
    unfollowEdit();
    edit.dispose();
    if (positionTargets.delete(position) && !positionTargets.size)
      positionDraft = null;
    observers.delete(observe);
    if (warningSource === frame) {
      warningSource = null;
      usePositionWarning.setState({ warning: null });
      useTextWarning.setState({ warning: null });
      pictureBox.publish(null);
    }
    if (hitTarget === hit) hitTarget = null;
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
  return {
    player,
    signal: closing.signal,
    async activate() {
      positionTargets.add(position);
      // Keep both documents following the gesture until the new one has painted its latest
      // draft. Promotion runs immediately after this resolves, before another event can edit it.
      let shown: PositionDraft | null;
      do {
        shown = positionDraft;
        if (shown) position(shown);
        await request("paint");
        closing.signal.throwIfAborted();
      } while (shown !== positionDraft);
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
      showDiagnostics();
    },
    /** Selection belongs to the shown document, including a retained picture after a superseded handoff. */
    present() {
      if (closing.signal.aborted) return;
      warningSource = frame;
      hitTarget = hit;
      observers.add(observe);
      observe(observedClip);
      send("meter", { enabled: true });
    },
    get state() {
      return state;
    },
    inspect: async () => void (await request("inspect")),
    painted: async () => void (await request("paint")),
    async authorizeTiming() {
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
    ) {
      if (!timingAllowed || !timingRevision)
        throw new Error("The preview has no timing revision.");
      const response = await fetch(`${frame.src}&cutroom-timing=1`, { signal });
      if (!response.ok)
        throw new Error("The saved preview timing is unavailable.");
      const snapshot = z
        .object({
          version: z.string(),
          timing: PreviewTimingSchema,
          live: z.boolean(),
        })
        .parse(await response.json());
      signal.throwIfAborted();
      if (!latest()) return false;
      if (!snapshot.live || !snapshot.timing.allowed)
        throw new Error("This preview requires a reload.");
      const reply = await request(
        "timing",
        {
          timing: snapshot.timing,
          expectedRevision: timingRevision,
          time,
        },
        signal,
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
