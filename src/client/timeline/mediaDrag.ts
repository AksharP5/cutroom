import type { InsertClip } from "../../shared/timeline/schema";

/** Marks a drag as project media, so the timeline takes it and the Media panel's importer does not. */
export const MEDIA_DRAG_TYPE = "application/x-cutroom-media";
/** How long a still runs when it is dropped on the timeline. */
export const STILL_SECONDS = 5;

export interface MediaDrag {
  kind: InsertClip["kind"];
  /** The file's project-relative path. */
  path: string;
  seconds: number;
  hasAudio: boolean;
}

/**
 * The Media panel row being dragged. A browser hides a drag's data until the drop, and the
 * timeline needs the file's kind and length while it is still over a track.
 */
let dragged: MediaDrag | null = null;
export const setMediaDrag = (media: MediaDrag | null) => {
  dragged = media;
};
export const mediaDrag = () => dragged;
