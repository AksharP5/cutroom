import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { isMediaItem, previewMediaPath } from "../../shared/media";
import type { Clip } from "../../shared/timeline/schema";
import { fileMissing, useWorkspace } from "../workspace";
import { useTimeline } from "./timeline";
import { previewImageSources, useVariables } from "./variables";

const offlinePaths = new WeakMap<
  Readonly<Record<string, string | null>>,
  Map<string, Map<string, string | null>>
>();

export function offlineMediaPath(
  files: Readonly<Record<string, string | null>>,
  composition: string,
  src: string | null,
) {
  if (!src) return null;
  let compositions = offlinePaths.get(files);
  if (!compositions) {
    compositions = new Map();
    offlinePaths.set(files, compositions);
  }
  let sources = compositions.get(composition);
  if (!sources) {
    sources = new Map();
    compositions.set(composition, sources);
  }
  const cached = sources.get(src);
  if (cached !== undefined) return cached;
  const path = previewMediaPath(composition, src, files);
  const offline = path && fileMissing(files, composition, path) ? path : null;
  sources.set(src, offline);
  return offline;
}

/** One entry per missing file on the open timeline, at its earliest clip. */
export function useOfflineMedia(projectId: string) {
  const files = useWorkspace((state) => state.fileChanges);
  const variables = useVariables((current) =>
    current.projectId === projectId ? current.state : null,
  );
  const images = useMemo(() => previewImageSources(variables), [variables]);
  return useTimeline(
    useShallow((state) => {
      const sources = new Map<string, Clip>();
      if (state.projectId !== projectId || !state.view) return sources;
      const { composition, timeline } = state.view;
      for (const clip of timeline.clips) {
        const image = clip.variableBindings?.image;
        const override =
          image && variables?.composition === composition
            ? images.get(image)
            : undefined;
        const path = offlineMediaPath(files, composition, override ?? clip.src);
        if (!path || path.startsWith("../") || !isMediaItem(path)) continue;
        const first = sources.get(path);
        if (!first || first.start > clip.start) sources.set(path, clip);
      }
      return sources;
    }),
  );
}
