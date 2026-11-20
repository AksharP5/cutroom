import { create } from "zustand";
import { mediaKind, sourceUrl } from "../../shared/media";
import { clipName } from "../../shared/timeline/labels";
import { MAX_VERSIONS } from "../../shared/timeline/schema";
import type { Clip } from "../../shared/timeline/schema";
import {
  activeVersion,
  mediaVersions,
  versionOwner,
  versionPartners,
} from "../../shared/timeline/versions";
import { auditionPicture } from "./preview";
import { editTimeline, useTimeline } from "./timeline";
import { transport, useTransport } from "./transport";
import { api } from "../api";
import { SourceViewSchema } from "../../shared/timeline/view";
import { showToast } from "../workspace";
import type { MediaDrag } from "../timeline/mediaDrag";

export function canAddVersion(
  clip: Clip,
  view: NonNullable<ReturnType<typeof useTimeline.getState>["view"]>,
) {
  const { clips, tracks } = view.timeline;
  return Boolean(
    clip.src &&
    mediaVersions(clip.kind) &&
    versionOwner(clips, clip) === clip &&
    (clip.versions?.length ?? 0) < MAX_VERSIONS &&
    !tracks.some(
      (track) =>
        track.locked &&
        [clip, ...versionPartners(clips, clip)].some(
          ({ track: index }) => index === track.index,
        ),
    ),
  );
}

export function versionMediaTarget(
  state: ReturnType<typeof useTimeline.getState>,
  kind: MediaDrag["kind"],
) {
  if (!state.view || kind === "image") return undefined;
  const { clips } = state.view.timeline;
  const ofKind = clips.filter(
    (clip) =>
      state.selection.ids.has(clip.id) &&
      (kind === "video"
        ? clip.kind === "video"
        : clip.kind === "audio" || clip.kind === "voiceover") &&
      versionOwner(clips, clip) === clip,
  );
  return ofKind.length === 1 &&
    state.selection.ids.size ===
      1 +
        versionPartners(clips, ofKind[0]!).filter(({ id }) =>
          state.selection.ids.has(id),
        ).length
    ? ofKind[0]
    : undefined;
}

export function addClipVersion(
  clip: Clip,
  file?: Pick<MediaDrag, "path" | "start">,
) {
  const { projectId, view } = useTimeline.getState();
  if (!projectId || !view || !canAddVersion(clip, view)) return;
  const leaf = file?.path.split("/").at(-1);
  const name = leaf
    ?.slice(0, leaf.lastIndexOf("."))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  void editTimeline(projectId, `Added a version to ${clipName(clip)}`, () => [
    {
      type: "addVersion",
      clipId: clip.id,
      ...(file && {
        version: {
          name: name || leaf || "Take",
          src: sourceUrl(view.composition, file.path),
        },
        sourceSeconds: file.start ?? 0,
      }),
    },
  ]);
}

export async function addMediaVersion(
  projectId: string,
  clip: Clip,
  path: string,
) {
  try {
    const marks = await api(
      `/projects/${encodeURIComponent(projectId)}/source-marks?path=${encodeURIComponent(path)}`,
      SourceViewSchema,
    );
    const state = useTimeline.getState();
    const kind = mediaKind(path)?.kind;
    if (
      state.projectId === projectId &&
      kind &&
      versionMediaTarget(state, kind)?.id === clip.id
    )
      addClipVersion(clip, { path, start: marks.in ?? 0 });
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}

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
  const clip = findClip(id);
  return clip?.versions && !mediaVersions(clip.kind) ? id : null;
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
let returnTo: { frame: number; playing: boolean } | null = null;

function stopAudition() {
  useVersions.setState({ hovered: null });
  if (!returnTo) return;
  const prior = returnTo;
  returnTo = null;
  transport.loopSpan(null);
  if (!prior.playing) transport.dispatch({ type: "stop" });
  transport.seek(prior.frame);
}

/** Plays `clip` in a loop showing version `index`, or with null stops and returns. */
export function hoverVersion(clip: Clip, index: number | null) {
  if (index === null) {
    stopAudition();
    return;
  }
  useVersions.setState({ hovered: index });
  if (returnTo !== null) return;
  const { frame, state } = useTransport.getState();
  returnTo = { frame, playing: state.kind === "playing" };
  transport.loopSpan({ first: clip.start, end: clip.start + clip.duration });
  transport.seek(clip.start);
  if (!returnTo.playing) transport.dispatch({ type: "toggle" });
}

export function openVersions(clipId: string) {
  useVersions.setState({ open: clipId, hovered: null });
}

export function closeVersions() {
  stopAudition();
  useVersions.setState({ open: null, hovered: null });
}
