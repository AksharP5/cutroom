import { create } from "zustand";

const SETTING = "cutroom.footagePipeline";

/**
 * The viewer's footage pipeline. Off by default: Settings turns it on. While `active`, the
 * pipeline draws every video clip beneath the preview, and the preview draws everything else.
 */
export const usePipeline = create(() => ({
  enabled: localStorage.getItem(SETTING) === "true",
  active: false,
}));
usePipeline.subscribe(({ enabled }, previous) => {
  if (enabled !== previous.enabled)
    localStorage.setItem(SETTING, String(enabled));
});
