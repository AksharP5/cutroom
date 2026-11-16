import { expect, test } from "bun:test";
import { dragOffset, pickHit, snapLines } from "../src/client/edit/pictureDrag";

const box = { x: 0, y: 0, width: 10, height: 10 };
const hit = (clipId: string, painted: boolean) => ({ clipId, painted, box });
const frame = { width: 1920, height: 1080 };
const hidden = { safeZones: false, grid: false };
const lines = snapLines(frame, hidden, []);

test("a press picks what is drawn on top, unless the selected clip's box lies above it", () => {
  // A title's empty box over a video: the video is what the pointer is on.
  const stack = [hit("title", false), hit("video", true)];
  expect(pickHit(stack, null, false)?.clipId).toBe("video");
  // Once the title is selected its whole box grabs it.
  expect(pickHit(stack, "title", false)?.clipId).toBe("title");
  // A badge drawn over the selected video is still picked first.
  expect(
    pickHit([hit("badge", true), hit("video", true)], "video", false)?.clipId,
  ).toBe("badge");
  expect(pickHit([hit("title", false)], null, false)).toBeNull();
});

test("Alt steps down through the drawn clips and wraps to the top", () => {
  const stack = [hit("badge", true), hit("box", false), hit("video", true)];
  expect(pickHit(stack, null, true)?.clipId).toBe("badge");
  expect(pickHit(stack, "badge", true)?.clipId).toBe("video");
  expect(pickHit(stack, "video", true)?.clipId).toBe("badge");
  expect(pickHit([], "video", true)).toBeNull();
});

test("a drag lands on whole pixels and Shift keeps the larger direction", () => {
  const free = { axis: false, box: null, lines, reach: 0 };
  expect(dragOffset({ x: 12.4, y: -7.6 }, free)).toMatchObject({
    dx: 12,
    dy: -8,
  });
  expect(
    dragOffset({ x: 12.4, y: -30.2 }, { ...free, axis: true }),
  ).toMatchObject({ dx: 0, dy: -30 });
});

test("a box snaps its edges and centre to the frame's, exactly, within reach only", () => {
  // 301 px wide, so its centre is on a half pixel: snapping must still centre it exactly.
  const title = { x: 100, y: 900, width: 301, height: 80 };
  const options = { axis: false, box: title, lines, reach: 6 };
  expect(dragOffset({ x: 706, y: 0 }, options)).toEqual({
    dx: 709.5,
    dy: 0,
    guides: { x: 960, y: null },
  });
  // Left edge to the frame's left edge, bottom edge to its bottom.
  expect(dragOffset({ x: -97, y: 103 }, options)).toEqual({
    dx: -100,
    dy: 100,
    guides: { x: 0, y: 1080 },
  });
  expect(dragOffset({ x: 690, y: 40 }, options).guides).toEqual({
    x: null,
    y: null,
  });
  // The snap bypass and a locked axis both leave the pointer's own travel.
  expect(dragOffset({ x: 706, y: 0 }, { ...options, reach: 0 }).dx).toBe(706);
  expect(dragOffset({ x: 2, y: 103 }, { ...options, axis: true })).toEqual({
    dx: 0,
    dy: 100,
    guides: { x: null, y: 1080 },
  });
});

test("safe zones, the grid and other clips pull a box only while they show", () => {
  expect(snapLines(frame, hidden, [])).toEqual({
    x: [0, 960, 1920],
    y: [0, 540, 1080],
  });
  // The hyperframes-studio skill's boxes: action-safe 5% in, title-safe 10% in.
  const safe = snapLines(frame, { safeZones: true, grid: false }, []);
  expect([...safe.x].sort((a, b) => a - b)).toEqual([
    0, 96, 192, 960, 1728, 1824, 1920,
  ]);
  expect(new Set(safe.y)).toEqual(new Set([0, 54, 108, 540, 972, 1026, 1080]));
  // A vertical frame lifts the caption line to 28% from the bottom.
  expect(
    snapLines(
      { width: 1080, height: 1920 },
      { safeZones: true, grid: false },
      [],
    ).y,
  ).toContain(1382.4);
  expect(snapLines(frame, { safeZones: false, grid: true }, []).x).toEqual([
    0, 960, 1920, 640, 1280,
  ]);
  const badge = { x: 1400, y: 200, width: 200, height: 100 };
  expect(snapLines(frame, hidden, [badge])).toEqual({
    x: [0, 960, 1920, 1400, 1500, 1600],
    y: [0, 540, 1080, 200, 250, 300],
  });
});

test("a dragged box snaps to the nearest line of any kind", () => {
  const title = { x: 100, y: 100, width: 400, height: 100 };
  const badge = { x: 1400, y: 600, width: 200, height: 100 };
  const options = {
    axis: false,
    box: title,
    lines: snapLines(frame, { safeZones: true, grid: false }, [badge]),
    reach: 6,
  };
  // The title's centre (300) meets the badge's centre (1500); its top (100) meets title-safe.
  expect(dragOffset({ x: 1197, y: 5 }, options)).toEqual({
    dx: 1200,
    dy: 8,
    guides: { x: 1500, y: 108 },
  });
  // Its right edge lands three pixels short of the badge's left edge.
  expect(dragOffset({ x: 897, y: 300 }, options).guides.x).toBe(1400);
});
