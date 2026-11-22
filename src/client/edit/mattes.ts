import { create } from "zustand";
import { api, json, subscribeProjectEvents } from "../api";
import { localMediaPath } from "../../shared/media";
import {
  MatteStatusSchema,
  clipMatte,
  clipSourceRange,
} from "../../shared/matte";
import type { MatteStatus } from "../../shared/matte";
import type { Clip, Fps } from "../../shared/timeline/schema";
import { useTimeline } from "./timeline";

/** The open project's matte jobs and mattes, as the server reports them. */
export const useMattes = create<{
  projectId: string | null;
  status: MatteStatus | null;
}>(() => ({ projectId: null, status: null }));

const path = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/mattes`;
const SYNC_MS = 300;

/** Asks the server to queue whatever the open timeline's Remove clips lack. */
export async function syncMattes(projectId: string) {
  const composition = useTimeline.getState().composition;
  const status = await api(
    `${path(projectId)}/sync?composition=${encodeURIComponent(composition)}`,
    MatteStatusSchema,
    json("POST"),
  );
  if (useMattes.getState().projectId === projectId)
    useMattes.setState({ status });
}

export async function stopMatte(projectId: string, job: string) {
  const status = await api(
    `${path(projectId)}/${encodeURIComponent(job)}`,
    MatteStatusSchema,
    json("DELETE"),
  );
  useMattes.setState({ status });
}

/** Runs a failed range again. */
export async function retryMatte(
  projectId: string,
  request: { src: string; from: number; to: number },
) {
  const status = await api(
    path(projectId),
    MatteStatusSchema,
    json("POST", { ...request, retry: true }),
  );
  useMattes.setState({ status });
}

export const downloadMatteModel = () =>
  fetch("/api/cutroom/mattes/model", { method: "POST" });
export const cancelMatteModel = () =>
  fetch("/api/cutroom/mattes/model", { method: "DELETE" });

/**
 * Follows the project's matte events, and after each timeline change that leaves a clip with its
 * background removed, asks for any frames it lacks.
 */
export function watchMattes(projectId: string, signal: AbortSignal) {
  useMattes.setState({ projectId, status: null });
  void api(path(projectId), MatteStatusSchema, { signal })
    .then((status) => {
      if (!signal.aborted) useMattes.setState({ status });
    })
    .catch(() => {});
  const stopEvents = subscribeProjectEvents(projectId, "matte", (event) => {
    const status = MatteStatusSchema.safeParse(JSON.parse(event.data));
    if (status.success) useMattes.setState({ status: status.data });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimeline = useTimeline.subscribe((state, previous) => {
    if (state.projectId !== projectId || state.view === previous.view) return;
    // A timeline with no Remove clip, before or after, asks nothing, so most edits cost
    // nothing here. One that just lost its last lets its jobs go.
    const removing = (view: typeof state.view) =>
      view?.timeline.clips.some((clip) => clip.background) ?? false;
    if (!removing(state.view) && !removing(previous.view)) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => void syncMattes(projectId).catch(() => {}),
      SYNC_MS,
    );
  });
  signal.addEventListener("abort", () => {
    stopEvents();
    stopTimeline();
    clearTimeout(timer);
    useMattes.setState({ projectId: null, status: null });
  });
}

/** The source range and matte state of a clip with its background removed; null otherwise. */
export function clipMatteState(
  status: MatteStatus | null,
  composition: string,
  clip: Clip,
  fps: Fps,
) {
  if (!clip.background || !status) return null;
  const range = clipSourceRange(clip, fps);
  const src = range && localMediaPath(composition, clip.src!);
  if (!range || !src) return null;
  return { src, ...range, ...clipMatte(status, src, range.from, range.to) };
}
export type ClipMatteState = NonNullable<ReturnType<typeof clipMatteState>>;

export function useClipMatte(clip: Clip | null | undefined) {
  const status = useMattes((state) => state.status);
  const view = useTimeline((state) => state.view);
  if (!clip || !view) return null;
  return clipMatteState(status, view.composition, clip, view.timeline.fps);
}

/**
 * What the viewer draws ahead of a save: Shrink or Soften while dragged, and the clip whose matte
 * Show matte draws in black and white.
 */
export const useMatteView = create<{
  draft: { clipId: string; shrink: number; soften: number } | null;
  shown: string | null;
}>(() => ({ draft: null, shown: null }));
