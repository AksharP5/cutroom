import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";
import { comboOf, keymap, keymapTable } from "../src/client/keymap";

const press = (
  code: string,
  modifiers: Partial<
    Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>
  > = {},
) =>
  comboOf({
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  });

test("key presses name their combo by key position, as the keymap writes it", () => {
  expect(press("KeyL")).toBe("L");
  expect(press("KeyL", { shiftKey: true })).toBe("Shift+L");
  expect(press("Semicolon", { shiftKey: false })).toBe(";");
  expect(press("Quote")).toBe("'");
  expect(press("Digit4")).toBe("4");
  expect(press("KeyZ", { ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+Z");
  expect(press("KeyX", { altKey: true })).toBe("Alt+X");
  expect(press("KeyZ", { metaKey: true })).toBeNull();
  expect(press("F13")).toBeNull();
});

test("every combo in the keymap is bound to exactly one action", () => {
  const keys = Object.values(keymap).flatMap((binding) => binding.keys);
  expect(new Set(keys).size).toBe(keys.length);
});

/** Table rows as trimmed cells, so column padding from the formatter does not matter. */
const rows = (markdown: string) =>
  markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.trim().replace(/^-+$/, "---"))
        .join("|"),
    );

test("the keyboard docs show the keymap as it is", async () => {
  const docs = await readFile(
    new URL("../docs/keyboard.md", import.meta.url),
    "utf8",
  );
  expect(rows(docs)).toEqual(rows(keymapTable()));
});
