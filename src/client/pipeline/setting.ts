import { create } from "zustand";

const SETTING = "cutroom.footagePipeline";

/**
 * The viewer's footage pipeline. Off by default: Settings turns it on. While `active`, the
 * pipeline draws the video clips in `drawn` beneath the preview, and the preview draws the rest.
 */
export const usePipeline = create(() => ({
  enabled: localStorage.getItem(SETTING) === "true",
  active: false,
  drawn: [] as readonly string[],
  native: [] as readonly string[],
}));
usePipeline.subscribe(({ enabled }, previous) => {
  if (enabled !== previous.enabled)
    localStorage.setItem(SETTING, String(enabled));
});
