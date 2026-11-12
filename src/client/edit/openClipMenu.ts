import type { Clip } from "../../shared/timeline/schema";
import { openContextMenu } from "../components/ContextMenu";
import { useWorkspace } from "../workspace";
import { clipMenuItems } from "./clipMenu";
import { hasClipboard, useTimeline } from "./timeline";
import { useTransport } from "./transport";

/** The Media row listing a clip's file, when the panel shows it. */
function mediaRow(clip: Clip | undefined) {
  const path = clip?.src?.replace(/^\.\//, "");
  const row = path
    ? document.querySelector<HTMLElement>(
        `.media-row[data-path="${CSS.escape(path)}"]`,
      )
    : null;
  return row?.checkVisibility() ? row : null;
}

/**
 * Opens the clip menu for the selection as it stands. `clicked` is the clip a right-click landed
 * on, already selected; without one, as from the menu key, the first selected clip stands in.
 */
export function openClipMenu(
  event: Parameters<typeof openContextMenu>[0],
  projectId: string,
  anchor: Parameters<typeof openContextMenu>[3],
  clicked?: Clip,
) {
  const { view, selection } = useTimeline.getState();
  if (!view) return;
  const row = mediaRow(
    clicked ?? view.timeline.clips.find((clip) => selection.ids.has(clip.id)),
  );
  openContextMenu(
    event,
    "Clip",
    clipMenuItems({
      timeline: view.timeline,
      selection: selection.ids,
      frame: useTransport.getState().frame,
      clipboard: hasClipboard(projectId),
      inspector: useWorkspace.getState().inspector,
      onReveal: row && (() => row.focus()),
      onInspector: () =>
        useWorkspace.setState(({ inspector }) => ({ inspector: !inspector })),
    }),
    anchor,
  );
}
