import { create } from "zustand";
import type { Clip } from "../../shared/timeline/schema";
import { activeVersion } from "../../shared/timeline/versions";
import { auditionPicture } from "./preview";
import { useTimeline } from "./timeline";
import { transport, useTransport } from "./transport";

/**
 * A clip's versions in the editor. The preview document can carry every version of one clip,
 * hidden but loaded, so the picture switches between them within a frame: that clip is the one
 * whose list is open, or else the one selected clip with versions. Its active version is the
 * one the compiler built, so it draws exactly as export does.
 */
export const useVersions = create(() => ({
  /** The clip whose versions list is open. */
  open: null as string | null,
  /** The version the pointer or keys rest on in that list, which the picture plays. */
  hovered: null as number | null,
  /** The clip whose versions the shown document carries, and that document. */
  loaded: null as { clipId: string; gen: number } | null,
}));

const findClip = (id: string | null) =>
  id === null
    ? undefined
    : useTimeline
        .getState()
        .view?.timeline.clips.find((clip) => clip.id === id);

/** The clip whose versions the next preview document should carry, or null. */
export function auditionClip(): string | null {
  const { open } = useVersions.getState();
  if (open) return open;
  const { selection } = useTimeline.getState();
  if (selection.ids.size !== 1) return null;
  const [id = null] = selection.ids;
  return findClip(id)?.versions ? id : null;
}

/** The preview query that asks for a document carrying `clipId`'s versions. */
export const auditionQuery = (clipId: string | null) =>
  clipId === null ? "" : `&cutroom-audition=${encodeURIComponent(clipId)}`;

let shown: string | null = null;
/** Shows the hovered version, or the active one, in a document that carries them. */
function showVersion() {
  const { loaded, open, hovered } = useVersions.getState();
  const clip = findClip(loaded?.clipId ?? null);
  if (!loaded || !clip?.versions) return;
  const index =
    open === clip.id && hovered !== null ? hovered : activeVersion(clip);
  const key = `${loaded.gen}:${clip.id}:${index}`;
  if (key === shown) return;
  shown = key;
  auditionPicture(index);
}
useVersions.subscribe(showVersion);
useTimeline.subscribe(showVersion);

/** Where the playhead was before the list started playing a clip, to return to. */
let returnTo: number | null = null;

/** Plays `clip` in a loop showing version `index`, or with null stops and returns. */
export function hoverVersion(clip: Clip, index: number | null) {
  useVersions.setState({ hovered: index });
  if (index === null) {
    if (returnTo === null) return;
    transport.loopSpan(null);
    transport.seek(returnTo);
    returnTo = null;
    return;
  }
  if (returnTo !== null) return;
  returnTo = useTransport.getState().frame;
  transport.loopSpan({ first: clip.start, end: clip.start + clip.duration });
  transport.seek(clip.start);
  transport.dispatch({ type: "toggle" });
}

export function openVersions(clipId: string) {
  useVersions.setState({ open: clipId, hovered: null });
}

export function closeVersions() {
  const clip = findClip(useVersions.getState().open);
  if (clip) hoverVersion(clip, null);
  useVersions.setState({ open: null, hovered: null });
}
