import { expect, test } from "bun:test";
import type { GradeRequest } from "../src/client/pipeline/gradeWorker";
import type { FilmGradeJob } from "../src/client/timeline/filmGradeWorker";
import { filmGrades } from "../src/client/timeline/filmGrades";

test("graded filmstrips settle when the canvas asks for more tiles than the cache holds", async () => {
  class Bitmap implements ImageBitmap {
    constructor(
      public width: number,
      public height: number,
      readonly x = 0,
    ) {}
    close() {
      this.width = this.height = 0;
    }
  }

  const waiting: (() => void)[] = [];
  const baked: number[] = [];
  class TestWorker {
    onmessage?: (event: MessageEvent) => void;
    postMessage(message: GradeRequest | FilmGradeJob[]) {
      if (Array.isArray(message)) {
        waiting.push(() => {
          const results = message.map(({ key, image }) => {
            if (image instanceof Bitmap) baked.push(image.x);
            return { key, image };
          });
          this.onmessage?.(new MessageEvent("message", { data: results }));
        });
      } else {
        queueMicrotask(() => {
          const { key, size } = message;
          this.onmessage?.(
            new MessageEvent("message", {
              data: { key, data: new Uint8Array(size ** 3 * 4) },
            }),
          );
        });
      }
    }
    terminate() {}
  }

  const globals = {
    Worker: TestWorker,
    createImageBitmap: (
      _source: ImageBitmap,
      x: number,
      _y: number,
      w: number,
      h: number,
    ) => Promise.resolve(new Bitmap(w, h, x)),
  };
  const descriptors = Object.keys(globals).map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, value });

  let redraws = 0;
  let needsPaint = false;
  const grades = filmGrades("test-filmstrip-cache", () => {
    redraws++;
    needsPaint = true;
  });
  const tileSize = 1024; // Eight of these crops fit in 32 MiB.
  const sheet = new Bitmap(tileSize * 10, tileSize);
  const grade = grades.identify({ adjust: { exposure: 1 } }, "index.html", {})!;
  function paint(firstVisible: number) {
    needsPaint = false;
    grades.beginPaint(true);
    // Buffered tiles are visited first, as they can be in the canvas.
    const images = Array.from({ length: 10 }, (_, i) =>
      grades.tile(
        "clip",
        sheet,
        [i * tileSize, 0, tileSize, tileSize],
        grade,
        i === firstVisible || i === firstVisible + 1,
      ),
    );
    grades.endPaint();
    return images;
  }
  async function flush(firstVisible: number) {
    // Bound work even on the broken implementation, where every redraw starts another batch.
    for (let step = 0; step < 12; step++) {
      if (needsPaint) paint(firstVisible);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const reply = waiting.shift();
      if (!reply) return;
      reply();
    }
    throw new Error(
      `Filmstrip still baking after ${baked.length} tiles and ${redraws} redraws.`,
    );
  }

  try {
    paint(8);
    await flush(8);
    expect(baked.slice(0, 2)).toEqual([8 * tileSize, 9 * tileSize]);
    expect(baked).toHaveLength(8);
    const warmed = paint(8);
    expect(warmed.slice(8).every((image) => image !== undefined)).toBe(true);
    expect(warmed.filter(Boolean)).toHaveLength(8);

    // Two misses become visible. Prefetch must give up enough space to grade them.
    paint(6);
    await flush(6);
    const scrolled = paint(6);
    expect(scrolled.slice(6, 8).every((image) => image !== undefined)).toBe(
      true,
    );
    expect(warmed.filter((image) => image?.width)).toHaveLength(6);
    expect(scrolled.filter(Boolean)).toHaveLength(8);
    expect(baked).toHaveLength(10);

    const before = redraws;
    paint(6);
    await flush(6);
    expect(redraws).toBe(before);
    expect(baked).toHaveLength(10);
  } finally {
    grades.dispose();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
