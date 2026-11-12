import { keymap } from "../keymap";
import type { Action } from "../keymap";

/**
 * One row of a context menu. A row with a keymap `action` takes its label and key hint from the
 * keymap and runs the handler that key runs, so the menu can never say or do something else.
 */
export type MenuEntry = (
  { action: Action } | { label: string; run(): void }
) & {
  disabled?: boolean;
  /** Present on a row that shows a state: a check mark when true. */
  checked?: boolean;
  /** A checked row that is one choice among its neighbours. */
  radio?: boolean;
};
export type MenuItem = MenuEntry | "separator";

/** What a row shows: its label, and the first key bound to its action. */
export const itemText = (item: MenuEntry) =>
  "action" in item
    ? { label: keymap[item.action].label, keys: keymap[item.action].keys[0] }
    : { label: item.label, keys: undefined };

/** Letters typed within half a second of each other search together. */
export interface MenuSearch {
  text: string;
  at: number;
}

/**
 * Where a key moves focus among a menu's or a listbox's items, from the item at `index`, or -1
 * when none has focus. Arrows wrap, Home and End jump to the ends, and letters find the next
 * label that starts with what was typed. Null when the key is not one of these.
 */
export function menuStep(
  event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  labels: readonly string[],
  index: number,
  search: MenuSearch,
): number | null {
  const count = labels.length;
  if (!count) return null;
  switch (event.key) {
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowUp":
      return index < 0 ? count - 1 : (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
  }
  if (
    event.key.length !== 1 ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.key === " "
  )
    return null;
  const now = Date.now();
  search.text =
    (now - search.at < 500 ? search.text : "") + event.key.toLocaleLowerCase();
  search.at = now;
  // The same letter again steps through the labels that start with it.
  const prefix = [...search.text].every((letter) => letter === search.text[0])
    ? search.text[0]!
    : search.text;
  const offset = labels.findIndex((_, offset) =>
    labels[(index + 1 + offset) % count]!.toLocaleLowerCase().startsWith(
      prefix,
    ),
  );
  return offset < 0 ? null : (index + 1 + offset) % count;
}
