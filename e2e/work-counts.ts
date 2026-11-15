import type { CDPSession, Page } from "@playwright/test";

/**
 * Counts per gesture, after Powermove's structural performance tests (an idea only; see
 * docs/performance.md, Work counts). How much work the editor does for an input or a frame
 * depends on the code, not on how fast the runner is, so budgets on these counts hold on any
 * machine where frame-time budgets need repeats and still fail on slow runners.
 */
export async function installWorkCounters(page: Page) {
  await page.addInitScript(() => {
    if (window !== top) return;
    const counts = { commits: 0, bodyPaints: 0 };
    Object.assign(window, { cutroomWork: counts });
    // React reports every commit to a devtools hook that exists before it loads.
    Object.assign(window, {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE: () => {},
        onCommitFiberRoot: () => {
          counts.commits++;
        },
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        onScheduleFiberRoot: () => {},
      },
    });
    // Every redraw of the clip-body canvas starts by resizing it or clearing all of it.
    const isBodies = (canvas: HTMLCanvasElement) =>
      canvas.classList.contains("tl-bodies");
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h) {
      const { canvas } = this;
      if (
        isBodies(canvas) &&
        x === 0 &&
        y === 0 &&
        w === canvas.width &&
        h === canvas.height
      )
        counts.bodyPaints++;
      clearRect.call(this, x, y, w, h);
    };
    const width = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "width",
    )!;
    Object.defineProperty(HTMLCanvasElement.prototype, "width", {
      ...width,
      set(this: HTMLCanvasElement, value: number) {
        if (isBodies(this) && value !== this.width) counts.bodyPaints++;
        width.set!.call(this, value);
      },
    });
  });
}

interface TraceEvent {
  name: string;
  ph: string;
  tid: number;
  ts: number;
  dur?: number;
  args?: {
    elementCount?: number;
    beginData?: { frame?: string; dirtyObjects?: number };
  };
}

/** Style and layout work in one document. */
export interface FrameWork {
  /** Style recalculations that restyled at least one element. */
  styles: number;
  /** Elements restyled across those recalculations. */
  styled: number;
  /** Layouts with dirty objects. */
  layouts: number;
  /** Objects laid out across those layouts. */
  laidOut: number;
  /**
   * Style recalculations and layouts that script forced by reading style or geometry after
   * changing the page. The browser would otherwise do that work once, when it draws.
   */
  forced: number;
}

export interface Work {
  /** Animation frames the editor drew while the gesture ran. */
  frames: number;
  editor: FrameWork;
  /** The sandboxed preview document. */
  preview: FrameWork;
  /** React commits in the editor. */
  commits: number;
  /** Redraws of the timeline's clip-body canvas. */
  bodyPaints: number;
}

const scripts = new Set([
  "FunctionCall",
  "EventDispatch",
  "FireAnimationFrame",
  "TimerFire",
  "EvaluateScript",
  "FireIdleCallback",
]);

async function readTrace(cdp: CDPSession) {
  const complete = new Promise<string>((resolve) =>
    cdp.once("Tracing.tracingComplete", (event) => resolve(event.stream!)),
  );
  await cdp.send("Tracing.end");
  const handle = await complete;
  let contents = "";
  for (;;) {
    const chunk = await cdp.send("IO.read", { handle });
    contents += chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle });
  const { traceEvents }: { traceEvents: TraceEvent[] } = JSON.parse(contents);
  return traceEvents;
}

function frameWork(
  events: TraceEvent[],
  ours: (frame: string | undefined) => boolean,
): FrameWork {
  const mine = events.filter(
    (event) => event.ph === "X" && ours(event.args?.beginData?.frame),
  );
  const styles = mine.filter(
    (event) =>
      event.name === "UpdateLayoutTree" && (event.args?.elementCount ?? 0) > 0,
  );
  const layouts = mine.filter(
    (event) =>
      event.name === "Layout" && (event.args?.beginData?.dirtyObjects ?? 0) > 0,
  );
  const running = events.filter(
    (event) => event.ph === "X" && scripts.has(event.name),
  );
  const forced = (work: TraceEvent) =>
    running.some(
      (script) =>
        script.tid === work.tid &&
        script.ts <= work.ts &&
        script.ts + (script.dur ?? 0) >= work.ts + (work.dur ?? 0),
    );
  return {
    styles: styles.length,
    styled: styles.reduce((sum, e) => sum + (e.args?.elementCount ?? 0), 0),
    layouts: layouts.length,
    laidOut: layouts.reduce(
      (sum, e) => sum + (e.args?.beginData?.dirtyObjects ?? 0),
      0,
    ),
    forced: [...styles, ...layouts].filter(forced).length,
  };
}

/** Runs `gesture` under a Chromium trace and returns the work it caused. */
export async function measureWork(
  page: Page,
  cdp: CDPSession,
  gesture: () => Promise<unknown>,
): Promise<Work> {
  const counters = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            cutroomWork: { commits: number; bodyPaints: number };
          }
        ).cutroomWork,
    );
  const before = await counters();
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline",
    transferMode: "ReturnAsStream",
  });
  const frames = page.evaluate(() => {
    const frames = { count: 0, running: true };
    Object.assign(window, { cutroomFrames: frames });
    return new Promise<number>((resolve) => {
      const tick = () => {
        if (!frames.running) return resolve(frames.count);
        frames.count++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  await gesture();
  await page.evaluate(() => {
    (
      window as unknown as { cutroomFrames: { running: boolean } }
    ).cutroomFrames.running = false;
  });
  const after = await counters();
  const events = await readTrace(cdp);
  // Trace events name their frame. The only other frame is the sandboxed preview, which runs
  // in its own renderer and may be replaced by a new document.
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const editor = frameTree.frame.id;
  return {
    frames: await frames,
    editor: frameWork(events, (frame) => frame === editor),
    preview: frameWork(events, (frame) => !!frame && frame !== editor),
    commits: after.commits - before.commits,
    bodyPaints: after.bodyPaints - before.bodyPaints,
  };
}

/**
 * Waits until the editor has had no React commit or canvas redraw for `quiet` frames, so a
 * measurement covers every reply an edit causes rather than whatever fits in a fixed wait.
 */
export function settle(page: Page, quiet = 30) {
  return page.evaluate(async (quiet) => {
    const work = (
      window as unknown as {
        cutroomWork: { commits: number; bodyPaints: number };
      }
    ).cutroomWork;
    const deadline = performance.now() + 10_000;
    let last = `${work.commits}:${work.bodyPaints}`;
    let still = 0;
    while (still < quiet && performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = `${work.commits}:${work.bodyPaints}`;
      still = now === last ? still + 1 : 0;
      last = now;
    }
  }, quiet);
}
