import { expect, test } from "bun:test";
import { itemText, menuStep } from "../src/client/components/menu";
import type { MenuEntry } from "../src/client/components/menu";
import { clipMenuItems } from "../src/client/edit/clipMenu";
import { keymap, keymapAreas } from "../src/client/keymap";
import type { Action } from "../src/client/keymap";
import { normalizeTimeline } from "../src/shared/timeline/apply";

/** One clip, "a", on V1 from frame 30 to 90. */
const timeline = normalizeTimeline({
  fps: { num: 30, den: 1 },
  duration: 300,
  tracks: [
    {
      index: 0,
      kind: "video",
      name: null,
      locked: false,
      autoSelect: true,
      enabled: true,
      muted: false,
      solo: false,
    },
  ],
  clips: [
    {
      id: "a",
      track: 0,
      kind: "video",
      start: 30,
      duration: 60,
      mediaStart: 0,
      playbackRate: 1,
      src: "a.mp4",
      sourceDuration: null,
      link: null,
      label: null,
      volume: null,
      opacity: null,
      x: null,
      y: null,
      text: null,
      title: null,
      fadeIn: 0,
      fadeOut: 0,
      automation: null,
      enabled: true,
      hasAudio: false,
      startRef: null,
    },
  ],
  markers: [],
  range: { in: null, out: null },
});

const rows = (
  state: Partial<Parameters<typeof clipMenuItems>[0]> & { selected?: string[] },
) =>
  clipMenuItems({
    timeline,
    selection: new Set(state.selected ?? []),
    frame: 0,
    clipboard: false,
    inspector: false,
    onReveal: null,
    onInspector() {},
    ...state,
  }).filter((item): item is MenuEntry => item !== "separator");

const disabled = (items: MenuEntry[]) =>
  items.flatMap((item) => (item.disabled ? [itemText(item).label] : []));

test("a menu row for a keymap action shows the keymap's label and its first key", () => {
  expect(itemText({ action: "editDelete" })).toEqual({
    label: "Ripple delete",
    keys: "Shift+X",
  });
  expect(itemText({ label: "Reveal media", run() {} })).toEqual({
    label: "Reveal media",
    keys: undefined,
  });
  // Every edit in the clip menu is a keymap action, so none carries a label or key of its own.
  const actions: Action[] = [
    "editCut",
    "editCopy",
    "editPaste",
    "editPasteInsert",
    "editM2SplitClip",
    "editBackspace",
    "editDelete",
    "editClipEnabled",
    "editSelectClipsSelectTrackAfter",
  ];
  expect(rows({}).map(itemText)).toEqual([
    ...actions.map((action) => ({
      label: keymap[action].label,
      keys: keymap[action].keys[0],
    })),
    { label: "Reveal media", keys: undefined },
    { label: "Inspector", keys: undefined },
  ]);
});

test("the clip menu offers an edit only when its key would act on the selection", () => {
  // Nothing selected and nothing copied: only the forward selection needs no clip.
  expect(disabled(rows({}))).toEqual([
    keymap.editCut.label,
    keymap.editCopy.label,
    keymap.editPaste.label,
    keymap.editPasteInsert.label,
    keymap.editM2SplitClip.label,
    keymap.editBackspace.label,
    keymap.editDelete.label,
    keymap.editClipEnabled.label,
    "Reveal media",
  ]);
  // A selected clip can be cut, lifted and turned off; split waits for the playhead inside it.
  for (const frame of [30, 90])
    expect(disabled(rows({ selected: ["a"], clipboard: true, frame }))).toEqual(
      [keymap.editM2SplitClip.label, "Reveal media"],
    );
  expect(
    disabled(
      rows({ selected: ["a"], clipboard: true, frame: 31, onReveal() {} }),
    ),
  ).toEqual([]);
});

test("the shortcut sheet lists every keymap action once", () => {
  const listed = keymapAreas().flatMap(({ actions }) => actions);
  expect<string[]>(listed.toSorted()).toEqual(Object.keys(keymap).toSorted());
  expect(keymapAreas().every(({ actions }) => actions.length > 0)).toBe(true);
});

test("menu keys wrap at the ends and search labels by what was typed", () => {
  const labels = ["Cut", "Copy", "Paste", "Ripple delete", "Reveal media"];
  const key = (key: string) => ({
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  });
  const search = { text: "", at: 0 };
  expect(menuStep(key("ArrowUp"), labels, -1, search)).toBe(4);
  expect(menuStep(key("ArrowDown"), labels, 4, search)).toBe(0);
  expect(menuStep(key("End"), labels, 1, search)).toBe(4);
  // The same letter again steps to the next match; different letters narrow the search.
  expect(menuStep(key("r"), labels, 0, search)).toBe(3);
  expect(menuStep(key("r"), labels, 3, search)).toBe(4);
  search.at = 0;
  expect(menuStep(key("c"), labels, 4, search)).toBe(0);
  expect(menuStep(key("o"), labels, 0, search)).toBe(1);
  expect(
    menuStep({ ...key("x"), ctrlKey: true }, labels, 0, search),
  ).toBeNull();
  expect(menuStep(key("Enter"), labels, 0, search)).toBeNull();
});
