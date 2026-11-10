import { useEffect, useRef } from "react";

type Binding = { label: string; keys: readonly string[]; repeat?: boolean };

/**
 * Every editor shortcut, keyed by DaVinci Resolve's action id and bound as in the owner's Resolve
 * preset. Cutroom-only actions use a `cutroom` prefix. This table drives the key handlers,
 * button tooltips, and the table in `docs/keyboard.md`. Combos list modifiers as Ctrl, Alt, Shift.
 */
export const keymap = {
  editPointer: { label: "Select", keys: ["A"] },
  cutroomDraw: { label: "Draw", keys: ["Shift+N"] },
  cutroomComment: { label: "Comment", keys: ["N"] },
  controlPlayToggle: { label: "Play or stop", keys: ["Space"] },
  controlPlayForward: {
    label: "Play forward, faster on repeat",
    keys: ["L", "4"],
  },
  controlPlayReverse: {
    label: "Play reverse, faster on repeat",
    keys: ["J", "3"],
  },
  controlFastForward: { label: "Play forward at 4x", keys: ["Shift+L"] },
  controlFastReverse: { label: "Play reverse at 4x", keys: ["Shift+J"] },
  controlStop: { label: "Stop", keys: ["K"] },
  controlStepReverse: { label: "Previous frame", keys: ["Left"], repeat: true },
  controlStepForward: { label: "Next frame", keys: ["Right"], repeat: true },
  controlLargeStepReverse: {
    label: "Back one second",
    keys: ["Shift+Left"],
    repeat: true,
  },
  controlLargeStepForward: {
    label: "Forward one second",
    keys: ["Shift+Right"],
    repeat: true,
  },
  controlClipPrev: { label: "Previous edit", keys: ["Up"], repeat: true },
  controlClipNext: { label: "Next edit", keys: ["Down"], repeat: true },
  controlTimelineStart: { label: "Timeline start", keys: ["Home"] },
  controlTimelineEnd: { label: "Timeline end", keys: ["End"] },
  controlFirstFrame: { label: "First frame", keys: [";"] },
  controlLastFrame: { label: "Last frame", keys: ["'"] },
  markIn: { label: "Mark in", keys: ["I"] },
  markOut: { label: "Mark out", keys: ["O"] },
  markResetIn: { label: "Clear in", keys: ["Alt+I"] },
  markResetOut: { label: "Clear out", keys: ["Alt+O"] },
  markResetInOut: { label: "Clear in and out", keys: ["Alt+X"] },
  controlGotoIn: { label: "Go to in", keys: ["Shift+I"] },
  controlGotoOut: { label: "Go to out", keys: ["Shift+O"] },
  controlLoop: { label: "Loop", keys: ["Ctrl+/"] },
  editUndo: { label: "Undo", keys: ["Ctrl+Z", "`"] },
  editRedo: { label: "Redo", keys: ["Ctrl+Shift+Z"] },
  workspaceViewerModeCinemaViewer: {
    label: "Fullscreen viewer",
    keys: ["P", "Ctrl+F"],
  },
  viewZoomSubZoomToFit: {
    label: "Fit the timeline, or return to the last zoom",
    keys: ["Shift+Z"],
  },
  viewZoomSubZoomIn: {
    label: "Zoom the timeline in",
    keys: ["Ctrl+=", "Ctrl+Shift+="],
    repeat: true,
  },
  viewZoomSubZoomOut: {
    label: "Zoom the timeline out",
    keys: ["Ctrl+-"],
    repeat: true,
  },
  editSelectItemAtPlayhead: {
    label: "Select clips at the playhead",
    keys: ["Shift+V"],
  },
  editDeselectAll: { label: "Deselect all", keys: ["Shift+A", "Esc"] },
  trimRippleStartToPlayhead: {
    label: "Ripple trim the start to the playhead",
    keys: ["Q"],
  },
  trimRippleEndToPlayhead: {
    label: "Ripple trim the end to the playhead",
    keys: ["W"],
  },
  editBladeRazor: { label: "Razor at the playhead", keys: ["E"] },
  editM2SplitClip: { label: "Split at the playhead", keys: ["Ctrl+\\"] },
  editBackspace: { label: "Lift, leaving a gap", keys: ["X", "Backspace"] },
  editDelete: { label: "Ripple delete", keys: ["Shift+X", "Delete"] },
  editClipEnabled: { label: "Turn clips on or off", keys: ["D"] },
  markMarkerAdd: { label: "Add a marker", keys: ["M"] },
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
    /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
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
  !!target.closest(
    "input, textarea, select, [contenteditable]:not([contenteditable=false]), dialog",
  );

export function actionFor(event: KeyboardEvent): Action | null {
  if (isTyping(event.target)) return null;
  const combo = comboOf(event);
  const action = combo ? bindings.get(combo) : undefined;
  if (!action) return null;
  const binding: Binding = keymap[action];
  return event.repeat && !binding.repeat ? null : action;
}

/** `Label (L, 4)` for a button's tooltip. */
export const hint = (action: Action) =>
  `${keymap[action].label} (${keymap[action].keys.join(", ")})`;

/** Runs the handler bound to each key press. Handlers may change between renders. */
export function useKeymap(handlers: Partial<Record<Action, () => void>>) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
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
    return () => window.removeEventListener("keydown", press);
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
