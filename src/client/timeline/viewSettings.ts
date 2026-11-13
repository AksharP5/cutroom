import {
  TimelineViewSettingsSchema,
  emptyTimelineViewSettings,
} from "../../shared/timeline/view";
import { createViewPreferences } from "../viewPreferences";

/** Timeline layout and destination tracks, outside undo history. */
const preferences = createViewPreferences(
  TimelineViewSettingsSchema,
  emptyTimelineViewSettings,
);
export const useViewSettings = preferences.use;
export const saveViewSettings = preferences.save;
export function openViewSettings(projectId: string, composition: string) {
  return preferences.open(
    projectId,
    `/projects/${encodeURIComponent(projectId)}/timeline-view?composition=${encodeURIComponent(composition)}`,
  );
}
