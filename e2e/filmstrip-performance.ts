import type { Page } from "@playwright/test";

type Tile = { x: number; width: number; graded: boolean };
type Paint = { at: number; tiles: Tile[] };

/** Count the bitmaps actually drawn onto the timeline, following the worker's transferred images. */
export function watchFilmstrip(page: Page) {
  return page.addInitScript(() => {
    if (self !== top) return;
    const graded = new WeakSet<ImageBitmap>();
    const paints: Paint[] = [];
    const probe = { enabled: true, paints };
    Object.assign(window, { filmstripProbe: probe });
    window.Worker = new Proxy(window.Worker, {
      construct(
        Worker: typeof globalThis.Worker,
        args: ConstructorParameters<typeof globalThis.Worker>,
      ) {
        const worker = new Worker(...args);
        if (String(args[0]).includes("filmGradeWorker"))
          worker.addEventListener("message", ({ data }) => {
            if (Array.isArray(data))
              for (const { image } of data)
                if (image instanceof ImageBitmap) graded.add(image);
          });
        return worker;
      },
    });
    const ctx = CanvasRenderingContext2D.prototype;
    ctx.clearRect = new Proxy(ctx.clearRect, {
      apply(clear, context: CanvasRenderingContext2D, args: number[]) {
        const { canvas } = context;
        if (
          probe.enabled &&
          canvas.classList.contains("tl-bodies") &&
          args[0] === 0 &&
          args[1] === 0 &&
          args[2] === canvas.width &&
          args[3] === canvas.height
        )
          paints.push({ at: performance.now(), tiles: [] });
        Reflect.apply(clear, context, args);
      },
    });
    ctx.drawImage = new Proxy(ctx.drawImage, {
      apply(draw, context: CanvasRenderingContext2D, args: unknown[]) {
        if (
          probe.enabled &&
          context.canvas.classList.contains("tl-bodies") &&
          args.length === 9 &&
          args[0] instanceof ImageBitmap
        ) {
          if (!paints.length) paints.push({ at: performance.now(), tiles: [] });
          paints.at(-1)!.tiles.push({
            x: Number(args[5]),
            width: Number(args[7]),
            graded: graded.has(args[0]),
          });
        }
        Reflect.apply(draw, context, args);
      },
    });
  });
}

/** Sample Fit at a standstill, from the first complete source paint through the graded picture. */
export function filmstripSettle(page: Page) {
  return page.locator(".tl-bodies").evaluate(async (element) => {
    const { filmstripProbe: probe } = window as Window & {
      filmstripProbe?: { enabled: boolean; paints: Paint[] };
    };
    if (!probe) throw new Error("The filmstrip probe did not start.");
    const canvas = element.getBoundingClientRect();
    const viewport = element.closest(".tl-scroll")!.getBoundingClientRect();
    const left = (viewport.left - canvas.left) * devicePixelRatio;
    const right = (viewport.right - canvas.left) * devicePixelRatio;
    const pixelsInView = ({ x, width }: Pick<Tile, "x" | "width">) =>
      Math.max(0, Math.min(right, x + width) - Math.max(left, x));
    const visible = (tile: Tile) => pixelsInView(tile) > 0;
    // At Fit a tile may cover several clips. Check their visible width, including when
    // each clip still draws its own tile, so the warm-up requires picture across the lane.
    const minimum =
      Array.from(
        element.parentElement!.querySelectorAll(".tl-clip.video"),
        (clip) => {
          const box = clip.getBoundingClientRect();
          return pixelsInView({
            x: (box.left - canvas.left) * devicePixelRatio,
            width: box.width * devicePixelRatio,
          });
        },
      ).reduce((sum, width) => sum + width, 0) * 0.9;
    const covered = (tiles: Tile[]) =>
      tiles.reduce((sum, tile) => sum + pixelsInView(tile), 0);

    const deadline = performance.now() + 30_000;
    for (;;) {
      const latest = probe.paints.at(-1);
      const tiles = latest?.tiles.filter(visible) ?? [];
      if (
        latest &&
        tiles.length > 0 &&
        covered(tiles) >= minimum &&
        tiles.every((tile) => tile.graded)
      ) {
        const first = probe.paints.findIndex(
          (paint) => covered(paint.tiles) >= minimum,
        );
        probe.enabled = false;
        return {
          visibleTiles: tiles.length,
          paintMs: Math.round(latest.at - probe.paints[first]!.at),
          repaints: probe.paints.length - first - 1,
        };
      }
      if (performance.now() > deadline)
        throw new Error(
          `Only ${tiles.filter((tile) => tile.graded).length} of ${tiles.length} visible tiles graded in 30 seconds.`,
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
}
