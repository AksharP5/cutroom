import type { InsertClip } from "../../shared/timeline/schema";

/** Marks a drag as project media, so the timeline takes it and the Media panel's importer does not. */
export const MEDIA_DRAG_TYPE = "application/x-cutroom-media";
export { STILL_SECONDS } from "../../shared/media";

export interface MediaDrag {
  kind: InsertClip["kind"];
  /** The file's project-relative path. */
  path: string;
  /** How long it runs on the timeline: the whole file, or the part marked in the source viewer. */
  seconds: number;
  /** Seconds into the file where that part begins. */
  start?: number;
  hasAudio: boolean;
}

/**
 * The Media panel row or source viewer range being dragged. A browser hides a drag's data until the drop, and the
 * timeline needs the file's kind and length while it is still over a track.
 */
let dragged: MediaDrag | null = null;
const listeners = new Set<() => void>();
export function subscribeMediaDrag(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const setMediaDrag = (media: MediaDrag | null) => {
  dragged = media;
  for (const listener of listeners) listener();
};
export const mediaDrag = () => dragged;
