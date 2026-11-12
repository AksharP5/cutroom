import { useEffect, useRef } from "react";
import type { MouseEvent } from "react";

/** The shortcut sheet's groups, in an order that fills its three columns evenly. */
export const areas = [
  "Tools",
  "Playback",
  "Marks",
  "Playhead",
  "Select",
  "Edit",
  "View",
] as const;

type Binding = {
  area: (typeof areas)[number];
  label: string;
  keys: readonly string[];
  repeat?: boolean;
};

/**
 * Every editor shortcut, keyed by DaVinci Resolve's action id and bound as in the owner's Resolve
 * preset. Cutroom-only actions use a `cutroom` prefix. This table drives the key handlers,
 * button tooltips, menu items, the shortcut sheet, and the table in `docs/keyboard.md`. Combos
 * list modifiers as Ctrl, Alt, Shift.
 */
export const keymap = {
  workspacePrimaryWorkspaceDeliver: {
    area: "View",
    label: "Export",
    keys: ["Shift+8"],
  },
  editPointer: { area: "Tools", label: "Select", keys: ["A"] },
  editTrim: { area: "Tools", label: "Trim", keys: ["T"] },
  editBlade: { area: "Tools", label: "Blade", keys: ["B"] },
  cutroomDraw: { area: "Tools", label: "Draw", keys: ["Shift+N"] },
  cutroomComment: { area: "Tools", label: "Comment", keys: ["N"] },
  controlPlayToggle: {
    area: "Playback",
    label: "Play or stop",
    keys: ["Space"],
  },
  cutroomRecordVoiceover: {
    area: "Playback",
    label: "Record or stop voiceover",
    keys: ["Ctrl+Alt+Shift+V"],
  },
  controlPlayForward: {
    area: "Playback",
    label: "Play forward, faster on repeat",
    keys: ["L", "4"],
  },
  controlPlayReverse: {
    area: "Playback",
    label: "Play reverse, faster on repeat",
    keys: ["J", "3"],
  },
  controlFastForward: {
    area: "Playback",
    label: "Play forward at 4x",
    keys: ["Shift+L"],
  },
  controlFastReverse: {
    area: "Playback",
    label: "Play reverse at 4x",
    keys: ["Shift+J"],
  },
  controlStop: { area: "Playback", label: "Stop", keys: ["K"] },
  controlStepReverse: {
    area: "Playhead",
    label: "Previous frame",
    keys: ["Left"],
    repeat: true,
  },
  controlStepForward: {
    area: "Playhead",
    label: "Next frame",
    keys: ["Right"],
    repeat: true,
  },
  controlLargeStepReverse: {
    area: "Playhead",
    label: "Back one second",
    keys: ["Shift+Left"],
    repeat: true,
  },
  controlLargeStepForward: {
    area: "Playhead",
    label: "Forward one second",
    keys: ["Shift+Right"],
    repeat: true,
  },
  controlClipPrev: {
    area: "Playhead",
    label: "Previous edit",
    keys: ["Up"],
    repeat: true,
  },
  controlClipNext: {
    area: "Playhead",
    label: "Next edit",
    keys: ["Down"],
    repeat: true,
  },
  controlTimelineStart: {
    area: "Playhead",
    label: "Timeline start",
    keys: ["Home"],
  },
  controlTimelineEnd: {
    area: "Playhead",
    label: "Timeline end",
    keys: ["End"],
  },
  controlFirstFrame: { area: "Playhead", label: "First frame", keys: [";"] },
  controlLastFrame: { area: "Playhead", label: "Last frame", keys: ["'"] },
  markIn: { area: "Marks", label: "Mark in", keys: ["I"] },
  markOut: { area: "Marks", label: "Mark out", keys: ["O"] },
  markResetIn: { area: "Marks", label: "Clear in", keys: ["Alt+I"] },
  markResetOut: { area: "Marks", label: "Clear out", keys: ["Alt+O"] },
  markResetInOut: { area: "Marks", label: "Clear in and out", keys: ["Alt+X"] },
  controlGotoIn: { area: "Playhead", label: "Go to in", keys: ["Shift+I"] },
  controlGotoOut: { area: "Playhead", label: "Go to out", keys: ["Shift+O"] },
  controlLoop: { area: "Playback", label: "Loop", keys: ["Ctrl+/"] },
  editCopy: { area: "Edit", label: "Copy clips", keys: ["Ctrl+C"] },
  editCut: {
    area: "Edit",
    label: "Cut clips, leaving a gap",
    keys: ["Ctrl+X"],
  },
  editPaste: { area: "Edit", label: "Paste clips", keys: ["Ctrl+V"] },
  editPasteInsert: {
    area: "Edit",
    label: "Paste insert",
    keys: ["Ctrl+Shift+V"],
  },
  editInsertOverwriteActionInsert: {
    area: "Edit",
    label: "Insert source at playhead",
    keys: ["F9"],
  },
  editInsertOverwriteActionOverwrite: {
    area: "Edit",
    label: "Overwrite with source at playhead",
    keys: ["F10"],
  },
  editUndo: { area: "Edit", label: "Undo", keys: ["Ctrl+Z", "`"] },
  editRedo: { area: "Edit", label: "Redo", keys: ["Ctrl+Shift+Z"] },
  viewToggleSourceTimeline: {
    area: "View",
    label: "Show the source or the timeline",
    keys: ["Alt+Q"],
  },
  workspaceViewerModeCinemaViewer: {
    area: "View",
    label: "Fullscreen viewer",
    keys: ["P", "Ctrl+F"],
  },
  viewZoomSubZoomToFit: {
    area: "View",
    label: "Fit the timeline, or return to the last zoom",
    keys: ["Shift+Z"],
  },
  viewZoomSubZoomIn: {
    area: "View",
    label: "Zoom the timeline in",
    keys: ["Ctrl+=", "Ctrl+Shift+="],
    repeat: true,
  },
  viewZoomSubZoomOut: {
    area: "View",
    label: "Zoom the timeline out",
    keys: ["Ctrl+-"],
    repeat: true,
  },
  editSelectItemAtPlayhead: {
    area: "Select",
    label: "Select clips at the playhead",
    keys: ["Shift+V"],
  },
  editSelectClipsSelectTrackAfter: {
    area: "Select",
    label: "Select clips forward on auto-select tracks",
    keys: ["Y"],
  },
  editSelectClipsSelectAllAfter: {
    area: "Select",
    label: "Select clips forward on all tracks",
    keys: ["Alt+Y"],
  },
  editSelectClipsSelectTrackBefore: {
    area: "Select",
    label: "Select clips backward on auto-select tracks",
    keys: ["Ctrl+Y"],
  },
  editSelectClipsSelectAllBefore: {
    area: "Select",
    label: "Select clips backward on all tracks",
    keys: ["Ctrl+Alt+Y"],
  },
  editDeselectAll: {
    area: "Select",
    label: "Deselect all",
    keys: ["Shift+A", "Esc"],
  },
  trimRippleStartToPlayhead: {
    area: "Edit",
    label: "Ripple trim the start to the playhead",
    keys: ["Q"],
  },
  trimRippleEndToPlayhead: {
    area: "Edit",
    label: "Ripple trim the end to the playhead",
    keys: ["W"],
  },
  editBladeRazor: { area: "Edit", label: "Razor at the playhead", keys: ["E"] },
  editM2SplitClip: {
    area: "Edit",
    label: "Split at the playhead",
    keys: ["Ctrl+\\"],
  },
  editBackspace: {
    area: "Edit",
    label: "Lift, leaving a gap",
    keys: ["X", "Backspace"],
  },
  editDelete: {
    area: "Edit",
    label: "Ripple delete",
    keys: ["Shift+X", "Delete"],
  },
  editClipEnabled: { area: "Edit", label: "Turn clips on or off", keys: ["D"] },
  markMarkerAdd: { area: "Marks", label: "Add a marker", keys: ["M"] },
  editSnapping: { area: "Tools", label: "Snapping", keys: ["C"] },
  resolveCustomizedActions: {
    area: "View",
    label: "Keyboard shortcuts",
    keys: ["Ctrl+Alt+K"],
  },
} satisfies Record<string, Binding>;

export type Action = keyof typeof keymap;

const bindings = new Map<string, Action>();
for (const [action, { keys }] of Object.entries(keymap) as [Action, Binding][])
  for (const key of keys) bindings.set(key, action);

const named: Record<string, string> = {
  Space: "Space",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Slash: "/",
  Equal: "=",
  Minus: "-",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Delete",
  Backslash: "\\",
};

/** The combo a key press makes, by key position so Shift never changes the key's name. */
export function comboOf(
  event: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
  >,
): string | null {
  const key =
    named[event.code] ??
    /^Key([A-Z])$/.exec(event.code)?.[1] ??
    /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1] ??
    /^F(?:[1-9]|1[0-2])$/.exec(event.code)?.[0];
  if (!key || event.metaKey) return null;
  return [
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}

/** Shortcuts never fire while the person types in a field or works in a dialog. */
export const isTyping = (target: EventTarget | null) =>
  target instanceof Element &&
  (!!target.ownerDocument.querySelector("dialog[open]") ||
    !!target.closest(
      "input, textarea, select, [role=combobox], [role=listbox], [contenteditable]:not([contenteditable=false]), dialog",
    ));

/** Pointer clicks leave editor buttons ready for Space playback; keyboard activation keeps focus. */
export function blurPointerButton(event: MouseEvent<HTMLElement>) {
  if (
    !event.detail ||
    !(event.target instanceof Element) ||
    isTyping(event.target) ||
    event.target.closest("[role=dialog], [role=menu]")
  )
    return;
  const button = event.target.closest("button");
  if (
    button &&
    !button.hasAttribute("aria-haspopup") &&
    button === button.ownerDocument.activeElement
  )
    button.blur();
}

export function actionFor(event: KeyboardEvent): Action | null {
  if (isTyping(event.target)) return null;
  if (
    event.code === "Space" &&
    event.target instanceof Element &&
    event.target.closest(
      "button:focus-visible, [role=button]:focus-visible, [role=checkbox]:focus-visible, [role=switch]:focus-visible, [role=menuitem]:focus-visible, [role=menuitemcheckbox]:focus-visible, [role=menuitemradio]:focus-visible, [role=dialog], [role=menu]",
    )
  )
    return null;
  const combo = comboOf(event);
  const action = combo ? bindings.get(combo) : undefined;
  if (!action) return null;
  const binding: Binding = keymap[action];
  return event.repeat && !binding.repeat ? null : action;
}

/** `Label (L, 4)` for a button's tooltip. */
export const hint = (action: Action) =>
  `${keymap[action].label} (${keymap[action].keys.join(", ")})`;

/** The shortcut sheet's content: each area with its actions, in keymap order. */
export const keymapAreas = () =>
  areas.map((area) => ({
    area,
    actions: (Object.keys(keymap) as Action[]).filter(
      (action) => keymap[action].area === area,
    ),
  }));

type Handlers = Partial<Record<Action, () => void>>;

/** The handlers on screen, first mounted first: the order their key listeners answer in. */
const mounted = new Set<{ current: Handlers }>();

/**
 * Runs an action through the handler its key runs, so a menu item or button does exactly what the
 * shortcut does. False when nothing on screen handles it.
 */
export function runAction(action: Action) {
  for (const handlers of mounted) {
    const handler = handlers.current[action];
    if (!handler) continue;
    handler();
    return true;
  }
  return false;
}

/** Runs the handler bound to each key press. Handlers may change between renders. */
export function useKeymap(handlers: Handlers) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    mounted.add(latest);
    const press = (event: KeyboardEvent) => {
      // A control that handled the key itself, such as the zoom slider, keeps it.
      if (event.defaultPrevented) return;
      const action = actionFor(event);
      const handler = action && latest.current[action];
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", press);
    return () => {
      mounted.delete(latest);
      window.removeEventListener("keydown", press);
    };
  }, []);
}

const code = (text: string) =>
  text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;

/** The Markdown table in `docs/keyboard.md`. */
export const keymapTable = () =>
  [
    "| Action | Keys | Action id |",
    "| --- | --- | --- |",
    ...(Object.entries(keymap) as [Action, Binding][]).map(
      ([action, { label, keys }]) =>
        `| ${label} | ${keys.map(code).join(", ")} | ${code(action)} |`,
    ),
  ].join("\n");
