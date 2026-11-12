import { expect, test } from "bun:test";
import { dragOffset, pickHit } from "../src/client/edit/pictureDrag";

const box = { x: 0, y: 0, width: 10, height: 10 };
const hit = (clipId: string, painted: boolean) => ({ clipId, painted, box });
const frame = { width: 1920, height: 1080 };

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
  const free = { axis: false, box: null, frame, reach: 0 };
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
  const options = { axis: false, box: title, frame, reach: 6 };
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
