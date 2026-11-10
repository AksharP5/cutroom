import type { Page } from "@playwright/test";

/**
 * Opens the embedded HyperFrames editor, which Settings keeps as a way back until Cutroom's own
 * editor has an inspector and source panels. Call it before the page loads.
 */
export const embeddedEditor = (page: Page) =>
  page.addInitScript(() => localStorage.setItem("cutroom.newEditor", "false"));
