import type { Clip } from "../../shared/timeline/schema";
import { openContextMenu } from "../components/ContextMenu";
import { showToast, useWorkspace } from "../workspace";
import { z } from "zod";
import { CommandSchema } from "../../shared/timeline/schema";
import { ApiError, api, json } from "../api";
import { clipMenuItems } from "./clipMenu";
import { editTimeline, hasClipboard, useTimeline } from "./timeline";
import { copyTitleStyle, hasTitleStyle, pasteTitleStyle } from "./titleStyle";
import { useTransport } from "./transport";

const PlanSchema = z.object({
  label: z.string(),
  commands: z.array(CommandSchema),
});

/**
 * Measures the audio a mix edit needs on the server, where the media is, then applies its
 * commands as one undo step, like any edit. A refusal says why in a toast.
 */
async function applyPlan(
  projectId: string,
  composition: string,
  kind: "duck" | "loudness",
  request: object,
) {
  try {
    const plan = await api(
      `/projects/${encodeURIComponent(projectId)}/audio/${kind}?composition=${encodeURIComponent(composition)}`,
      PlanSchema,
      json("POST", request),
    );
    await editTimeline(projectId, plan.label, () => plan.commands);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    showToast(error.message);
  }
}

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
      titleStyle: hasTitleStyle(projectId),
      inspector: useWorkspace.getState().inspector,
      onReveal: row && (() => row.focus()),
      onInspector: () =>
        useWorkspace.setState(({ inspector }) => ({ inspector: !inspector })),
      onCopyStyle: (title) => copyTitleStyle(projectId, title),
      onPasteStyle: (titles) =>
        pasteTitleStyle(
          projectId,
          titles.map((title) => title.id),
        ),
      clicked,
      onDuck: (bed, voices) =>
        void applyPlan(projectId, view.composition, "duck", {
          bed: bed.id,
          ...(voices.length && { voices: voices.map((voice) => voice.id) }),
        }),
      onNormalize: (clips) =>
        void applyPlan(projectId, view.composition, "loudness", {
          clipIds: clips.map((clip) => clip.id),
        }),
    }),
    anchor,
  );
}
