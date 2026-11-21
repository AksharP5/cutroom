import {
  FormatPreviewSchema,
  rateLabel,
  sameRate,
} from "../../shared/projectFormat";
import type { ProjectFormat } from "../../shared/projectFormat";
import {
  TAB_ORIGIN_HEADER,
  TimelineViewSchema,
} from "../../shared/timeline/schema";
import type { TimelineView } from "../../shared/timeline/schema";
import { api, json, tabOrigin } from "../api";
import { showToast } from "../workspace";
import { editCompositionSource, useTimeline } from "./timeline";

export function previewFormat(
  projectId: string,
  { composition, revision }: TimelineView,
  format: ProjectFormat,
  signal?: AbortSignal,
) {
  return api(
    `/projects/${encodeURIComponent(projectId)}/format-preview`,
    FormatPreviewSchema,
    {
      ...json("POST", { composition, expectedRevision: revision, format }),
      signal,
    },
  );
}

export function changeFormat(
  projectId: string,
  { composition, revision }: TimelineView,
  format: ProjectFormat,
) {
  return editCompositionSource(projectId, composition, () =>
    api(
      `/projects/${encodeURIComponent(projectId)}/commands`,
      TimelineViewSchema,
      {
        ...json("POST", {
          composition,
          expectedRevision: revision,
          commands: [{ type: "setFormat", ...format }],
        }),
        headers: { [TAB_ORIGIN_HEADER]: tabOrigin },
      },
    ),
  );
}

export function offerMediaFormat(
  projectId: string,
  view: TimelineView,
  format: ProjectFormat,
) {
  const { size, timeline } = view;
  if (
    size?.width === format.width &&
    size.height === format.height &&
    sameRate(timeline.fps, format.fps)
  )
    return;
  const current = useTimeline.getState();
  if (
    current.projectId !== projectId ||
    current.view?.revision !== view.revision
  )
    return;
  const dismiss = showToast(
    `Match video format? ${format.width} × ${format.height} · ${rateLabel(format.fps)} fps`,
    {
      label: "Match",
      run: () => {
        dismiss();
        void changeFormat(projectId, view, format).catch((error: unknown) =>
          showToast(error instanceof Error ? error.message : String(error)),
        );
      },
    },
    { tone: "info" },
  );
}
