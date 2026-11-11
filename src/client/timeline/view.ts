import type { Fps } from "../../shared/timeline/schema";
import {
  clampPpf,
  cssMilliseconds,
  fitPpf,
  frameAt,
  pageTarget,
  scrollForAnchor,
  settledScroll,
} from "./math";
import type { FrameRange } from "./math";

/** The most one wheel event zooms, in wheel pixels. */
const WHEEL_STEP = 24;

interface Extent {
  frames: number;
  fps: Fps;
}
interface Placement {
  ppf: number;
  scroll: number;
}
export interface ViewState {
  ppf: number;
  fit: number;
  fps: Fps;
  /** Fractional frames at the left and right edges of the visible lanes. */
  frames: FrameRange;
  /** Pixels of the track stack at the top and bottom edges. */
  rows: FrameRange;
}
export type TimelineViewport = ReturnType<typeof createViewport>;

/**
 * Owns zoom and scroll for one timeline. Pixels per frame is the `--ppf` property on `grid`, so
 * a zoom step is one property write plus the scroll offset that holds the anchor still. The
 * property is not inherited (see timeline.css), so the write restyles a handful of elements.
 *
 * `onChange` runs after every zoom, scroll and resize. With `flush` it must mount what the new
 * view shows before returning, because an animated zoom measures those elements next.
 */
export function createViewport(
  scroller: HTMLElement,
  grid: HTMLElement,
  headWidth: number,
  onChange: (flush: boolean) => void,
) {
  let ppf = 0;
  let fit = 0;
  let fitted = true;
  let gesturing = false;
  let extent: Extent = { frames: 0, fps: { num: 30, den: 1 } };
  /** The scroller's offset, in the whole pixels it keeps. */
  let scroll = 0;
  /** The offset zooming works from, with its fraction. See `settledScroll`. */
  let exact = 0;
  let width = 0;
  let height = 0;
  let top = 0;
  let animations: Animation[] = [];
  let wheel: { factor: number; x: number } | null = null;
  /** The zoom Shift+Z left, to return to on the next press. */
  let beforeFit: number | null = null;
  let refit: Animation | undefined;

  const cancelRefit = () => {
    refit?.cancel();
    refit = undefined;
  };

  const lanesLeft = () => scroller.getBoundingClientRect().left + headWidth;
  const write = (next: number) => {
    ppf = next;
    grid.style.setProperty("--ppf", String(ppf));
  };
  const scrollTo = (left: number) => {
    scroller.scrollLeft = left;
    scroll = scroller.scrollLeft;
    exact = settledScroll(left, scroll);
  };
  const stop = () => {
    for (const animation of animations) animation.cancel();
    animations = [];
  };
  const motion = (duration: string) => {
    const style = getComputedStyle(grid);
    return {
      duration: cssMilliseconds(style.getPropertyValue(duration)),
      easing: style.getPropertyValue("--ease-out").trim(),
      composite: "add",
    } as const;
  };

  function refitAfterSlide(duration: number) {
    if (!duration) return zoom(fit, 0, true);
    // Share the clips' animation clock so Fit cannot start before their final frame.
    const wait = (grid.querySelector(".tl-lanes") ?? grid).animate(
      {},
      { duration },
    );
    refit = wait;
    void wait.finished.then(
      () => {
        if (refit !== wait) return;
        refit = undefined;
        zoom(fit, 0, true);
      },
      () => {}, // The next input cancels the wait.
    );
  }

  /** What is on screen now, which differs from the layout while a zoom is still easing. */
  function shown(): Placement {
    const layer = grid.querySelector(".tl-scaled");
    if (!layer || !animations.length) return { ppf, scroll };
    const { a, e } = new DOMMatrixReadOnly(getComputedStyle(layer).transform);
    return { ppf: ppf * a, scroll: scroll - e };
  }

  /**
   * Eases from an earlier placement to the current layout. Clip bodies and ticks stretch on
   * their layers; names, labels and marks only travel, so text never distorts.
   */
  function ease(from: Placement, options: ReturnType<typeof motion>) {
    if (!options.duration) return;
    const left = lanesLeft();
    const x = (frame: number, at: Placement) => frame * at.ppf - at.scroll;
    const to = { ppf, scroll };
    const marks = [...grid.querySelectorAll<HTMLElement>("[data-unscaled]")];
    const name = marks.find((mark) => mark.style.getPropertyValue("--e"));
    // A clip name sticks this far inside the visible left edge until its clip's end pushes it out.
    const inset = name
      ? parseFloat(getComputedStyle(name).left) - headWidth
      : 0;
    const travel = marks.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      // Names and durations of clips too narrow to show them have no box.
      if (!rect.width) return [];
      const frame = Number(element.style.getPropertyValue("--f"));
      const end = element.style.getPropertyValue("--e");
      if (!end) return [{ element, by: x(frame, from) - x(frame, to) }];
      const start = x(frame, from) + inset;
      const stuck = Math.min(
        Math.max(start, inset),
        Math.max(start, x(Number(end), from) - inset - rect.width),
      );
      return [{ element, by: stuck - (rect.left - left) }];
    });
    animations = [
      ...[...grid.querySelectorAll(".tl-scaled")].map((layer) =>
        layer.animate(
          {
            transform: [
              `translateX(${to.scroll - from.scroll}px) scaleX(${from.ppf / to.ppf})`,
              "translateX(0) scaleX(1)",
            ],
          },
          options,
        ),
      ),
      ...travel.map(({ element, by }) =>
        element.animate(
          { transform: [`translateX(${by}px)`, "translateX(0)"] },
          options,
        ),
      ),
    ];
  }

  function zoom(target: number, anchor: number, animate: boolean) {
    cancelRefit();
    const next = clampPpf(target, fit);
    fitted = next === fit;
    if (next === ppf && (next !== fit || scroll === 0)) return;
    const from = animate ? shown() : null;
    const options = animate ? motion("--duration-zoom") : null;
    stop();
    const frame = (exact + anchor) / ppf;
    const left = next === fit ? 0 : scrollForAnchor(frame, anchor, next);
    const at = scroller.scrollLeft;
    write(next);
    // Setting even an unchanged scroll offset would lay out the new zoom synchronously.
    if (left === at) {
      scroll = at;
      exact = at;
    } else scrollTo(left);
    onChange(animate);
    if (from && options) ease(from, options);
  }

  /** The playhead when it is on screen, otherwise the middle of the view. */
  const anchorNear = (frame: number) => {
    const x = frame * ppf - scroll;
    return x >= 0 && x <= width ? x : width / 2;
  };

  function onWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    // Chromium reports a pinch as Ctrl+wheel steps of -100 * ln(scale), so this follows the
    // fingers exactly. A mouse wheel notch is 100 or more; capping it makes a notch about 1.27x.
    const delta = Math.max(
      -WHEEL_STEP,
      Math.min(WHEEL_STEP, event.deltaY || event.deltaX),
    );
    const factor = Math.exp(-delta / 100);
    const x = event.clientX - lanesLeft();
    if (wheel) {
      wheel = { factor: wheel.factor * factor, x };
      return;
    }
    wheel = { factor, x };
    requestAnimationFrame(() => {
      if (!wheel) return;
      const { factor, x } = wheel;
      wheel = null;
      zoom(ppf * factor, x, false);
    });
  }
  function onScroll() {
    scroll = scroller.scrollLeft;
    top = scroller.scrollTop;
    exact = settledScroll(exact, scroll);
    onChange(false);
  }
  const resized = new ResizeObserver(() => measure(extent));
  resized.observe(scroller);
  scroller.addEventListener("wheel", onWheel, { passive: false });
  scroller.addEventListener("scroll", onScroll, { passive: true });

  /** Let an edit close its gap at the old scale before easing back to Fit. */
  function measure(next: Extent) {
    const changed = next.frames !== extent.frames;
    const delay =
      fitted && changed && ppf > 0 ? motion("--duration-edit").duration : 0;
    cancelRefit();
    extent = next;
    width = scroller.clientWidth - headWidth;
    height = scroller.clientHeight;
    top = scroller.scrollTop;
    scroll = scroller.scrollLeft;
    exact = settledScroll(exact, scroll);
    grid.style.setProperty("--view", `${width}px`);
    fit = fitPpf(extent.frames, width, extent.fps);
    if (fitted && gesturing) {
      onChange(false);
      return;
    }
    if (delay) refitAfterSlide(delay);
    else {
      write(fitted ? fit : clampPpf(ppf, fit));
      fitted = ppf === fit;
    }
    onChange(false);
  }

  return {
    measure,
    /** A following drag keeps the scale it grabbed, including during an interrupted zoom. */
    gesture(active: boolean) {
      gesturing = active;
      cancelRefit();
      if (active) {
        if (animations.some((animation) => animation.playState === "running")) {
          const from = shown();
          stop();
          write(from.ppf);
          scrollTo(from.scroll);
          onChange(true);
        }
        return;
      }
      if (fitted && ppf !== fit)
        refitAfterSlide(motion("--duration-edit").duration);
    },
    /** Multiplies the zoom around a pixel offset in the lanes, tracking the input directly. */
    zoomBy: (factor: number, anchor: number) =>
      zoom(ppf * factor, anchor, false),
    /** Eases to a zoom, holding the playhead still when it is on screen. */
    zoomTo: (target: number, playhead: number, animate = true) =>
      zoom(target, anchorNear(playhead), animate),
    fit: (playhead: number) => zoom(fit, anchorNear(playhead), true),
    /** Fits the whole timeline; pressed again while fitted, returns to the zoom it left. */
    toggleFit(playhead: number) {
      if (!fitted) {
        beforeFit = ppf;
        zoom(fit, anchorNear(playhead), true);
      } else if (beforeFit) zoom(beforeFit, anchorNear(playhead), true);
    },
    state: (): ViewState => ({
      ppf,
      fit,
      fps: extent.fps,
      frames: { from: scroll / ppf, to: (scroll + width) / ppf },
      rows: {
        from: top,
        to: top + height,
      },
    }),
    frameAtClient: (clientX: number) =>
      frameAt(clientX - lanesLeft(), scroll, ppf),
    /**
     * Keeps the playhead on screen. Playback pages as `pageTarget` decides, as one short slide
     * so the jump reads as travel. With playback stopped (direction 0), a seek that lands off
     * screen is centred.
     */
    follow(frame: number, direction: 1 | 0 | -1) {
      const x = frame * ppf - scroll;
      if (!direction) {
        if (x < 0 || x > width) scrollTo(frame * ppf - width / 2);
        return;
      }
      const target = pageTarget(x, width, direction);
      if (target === null) return;
      const from = scroll;
      scrollTo(frame * ppf - target);
      // At either end of the timeline there is nowhere further to page.
      if (scroll === from) return;
      stop();
      const options = motion("--duration-page");
      if (!options.duration) return;
      animations = [...grid.querySelectorAll(".tl-ruler, .tl-lanes")].map(
        (layer) =>
          layer.animate(
            { transform: [`translateX(${scroll - from}px)`, "translateX(0)"] },
            options,
          ),
      );
    },
    destroy() {
      cancelRefit();
      stop();
      resized.disconnect();
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("scroll", onScroll);
    },
  };
}
