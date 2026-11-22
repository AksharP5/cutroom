import { create } from "zustand";
import { z } from "zod";
import {
  COMPONENT_SECONDS,
  LibraryAddedSchema,
  LibraryCatalogSchema,
  libraryTitle,
} from "../../shared/library";
import type { LibraryCatalog, LibraryItem } from "../../shared/library";
import { toFrames } from "../../shared/timeline/apply";
import { destinationTracks } from "../../shared/timeline/tracks";
import { ApiError, api, json } from "../api";
import type { MediaDrag } from "../timeline/mediaDrag";
import { useViewSettings } from "../timeline/viewSettings";
import { showToast, useWorkspace } from "../workspace";
import { editCompositionSource, useTimeline } from "./timeline";
import { transport, useTransport } from "./transport";

/**
 * The HyperFrames library as the panel shows it. The list is read the first time the tab opens
 * and kept for the page's life: it is pinned to a registry tag, so it never changes under it.
 */
export const useLibrary = create(() => ({
  status: "idle" as "idle" | "loading" | "ready" | "unreachable",
  catalog: null as LibraryCatalog | null,
  /** Names of the items whose files are on their way into the project. */
  adding: new Set<string>() as ReadonlySet<string>,
  /** Items the open project took files from. */
  used: { projectId: "", names: new Set<string>() as ReadonlySet<string> },
}));

/** Reads the list unless it is loaded; `retry` asks again after it could not be reached. */
export function loadLibrary(retry = false) {
  const { status } = useLibrary.getState();
  if (status === "loading" || (status !== "idle" && !retry)) return;
  // A saved list read while offline is read again, in case the network is back.
  if (status === "ready" && !useLibrary.getState().catalog?.offline) return;
  useLibrary.setState({ status: "loading" });
  void api("/library", LibraryCatalogSchema).then(
    (catalog) => useLibrary.setState({ status: "ready", catalog }),
    () =>
      useLibrary.setState(({ catalog }) => ({
        status: catalog ? "ready" : "unreachable",
      })),
  );
}

export function loadUsedLibrary(projectId: string) {
  void api(
    `/projects/${encodeURIComponent(projectId)}/library/used`,
    z.object({ names: z.array(z.string()) }),
  ).then(
    ({ names }) =>
      useLibrary.setState({ used: { projectId, names: new Set(names) } }),
    (error: unknown) => console.warn("Library", error),
  );
}

const setAdding = (name: string, adding: boolean) =>
  useLibrary.setState((state) => {
    const next = new Set(state.adding);
    if (adding) next.add(name);
    else next.delete(name);
    return { adding: next };
  });

/** How long an item runs once placed, in the open timeline's frames. */
export function libraryFrames(item: LibraryItem) {
  const { fps } = useTimeline.getState().view?.timeline ?? {
    fps: { num: 30, den: 1 },
  };
  return toFrames(item.duration ?? COMPONENT_SECONDS, fps);
}

/**
 * Copies the item into the project and places it, as the server's one undo step, in the queue
 * with the timeline's own edits. The new files join the editor's file list before the timeline is
 * read again, so the clip never shows as offline.
 */
export async function addFromLibrary(
  item: LibraryItem,
  placement: {
    track: number;
    at: number;
    mode: "insert" | "overwrite";
    duration?: number;
  },
) {
  const { projectId, view } = useTimeline.getState();
  if (!projectId || !view) return false;
  const title = libraryTitle(item.title);
  setAdding(item.name, true);
  try {
    await editCompositionSource(projectId, view.composition, async () => {
      const added = await api(
        `/projects/${encodeURIComponent(projectId)}/library`,
        LibraryAddedSchema,
        json("POST", {
          name: item.name,
          composition: view.composition,
          ...placement,
        }),
      );
      useWorkspace.setState(({ fileChanges }) => ({
        fileChanges: { ...fileChanges, ...added.versions },
      }));
      return added;
    });
    useLibrary.setState(({ used }) => ({
      used: {
        projectId,
        names: new Set([
          ...(used.projectId === projectId ? used.names : []),
          item.name,
        ]),
      },
    }));
    return true;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const dismiss = showToast(
      `Couldn't add ${title}. ${error instanceof ApiError && error.status === 502 ? "The download stopped." : raw}`,
      error instanceof ApiError && error.status === 502
        ? {
            label: "Details",
            run: () => {
              dismiss();
              showToast(raw);
            },
          }
        : null,
    );
    return false;
  } finally {
    setAdding(item.name, false);
  }
}

/**
 * Places the item at the playhead on the video destination track, as F9 and F10 place footage.
 * The playhead then moves to its end, so the next placement follows it.
 */
export async function placeLibraryAtPlayhead(
  item: LibraryItem,
  mode: "insert" | "overwrite",
  /** Frames to place, for a part marked in the source viewer; the item's own length otherwise. */
  frames = libraryFrames(item),
) {
  const timeline = useTimeline.getState().view?.timeline;
  if (!timeline) return;
  const { video, videoEnabled } = destinationTracks(
    timeline.tracks,
    useViewSettings.getState().destinations,
  );
  if (!videoEnabled) {
    showToast("Enable a destination to place this source", null, {
      tone: "info",
      transient: true,
    });
    return;
  }
  const { frame, duration } = useTransport.getState();
  // The playhead stops on the last frame, so from there the clip goes after it, at the end.
  const at = duration > 0 && frame === duration - 1 ? duration : frame;
  if (
    await addFromLibrary(item, {
      track: video.index,
      at,
      mode,
      ...(frames !== libraryFrames(item) && { duration: frames }),
    })
  )
    transport.follow(at + frames)();
}

/** The source viewer's entry for a library item: a scene at its own length, not a project file. */
export const librarySource = (item: LibraryItem): MediaDrag => ({
  kind: "composition",
  path: `library:${item.name}`,
  seconds: item.duration ?? COMPONENT_SECONDS,
  hasAudio: false,
  library: item,
});
