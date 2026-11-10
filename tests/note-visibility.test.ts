import { expect, test } from "bun:test";
import { NoteVisibility } from "../src/client/edit/noteVisibility";

const note = { id: "one", frame: 10, end: null };
test("single-frame notes hold for 1s in playback, fade for 200ms, and remain exact when parked", () => {
  const visibility = new NoteVisibility();
  expect(visibility.update([note], 9, false, 0).size).toBe(0);
  expect(visibility.update([note], 11, true, 20).get("one")).toBe("shown");
  expect(visibility.update([note], 40, true, 1019).get("one")).toBe("shown");
  expect(visibility.update([note], 41, true, 1020).get("one")).toBe("fading");
  expect(visibility.update([note], 45, true, 1220).size).toBe(0);
  expect(visibility.update([note], 10, false, 1300).get("one")).toBe("shown");
  expect(visibility.update([note], 11, false, 1310).size).toBe(0);
});

test("ranged notes remain visible throughout their range and hold on reverse playback", () => {
  const visibility = new NoteVisibility();
  const range = { ...note, end: 100 };
  visibility.update([range], 10, true, 0);
  expect(visibility.update([range], 90, true, 2000).get("one")).toBe("shown");
  expect(visibility.update([range], 101, true, 2100).get("one")).toBe("fading");
  expect(visibility.update([range], 110, true, 2300).size).toBe(0);
  visibility.update([note], 12, false, 3000);
  expect(visibility.update([note], 9, true, 3010).get("one")).toBe("shown");
});
