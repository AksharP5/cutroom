import {
  compositionDiagnosticsScript,
  compositionScriptSources,
} from "./diagnostics";
import type { DiagnosticWindow } from "./diagnostics";
import { parse } from "parse5";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";
import type { DefaultTreeAdapterTypes } from "parse5";
import { exportClipWindow, parseFpsWithDefault } from "@hyperframes/core";
import { compositionClipLocations } from "../timeline/composition";
import type { CompositionScope } from "../timeline/composition";
import { TimelineError } from "../../shared/timeline/apply";
import { canonicalText } from "../../shared/timeline/schema";
import { previewTiming } from "./previewTiming";
import type { PreviewTiming } from "../../shared/preview";
import type { EditFrame } from "../../shared/preview";

interface PreviewWindow extends DiagnosticWindow {
  CSSNumericValue: {
    parse(value: string): {
      toSum(): { values: Iterable<{ unit: string; value: number }> };
    };
  };
  gsap?: { getProperty(element: Element, property: string): unknown };
  __hf?: Window["__hf"] & {
    audioMeter?: {
      start(): void;
      stop(): void;
      read(): { master: { l: number; r: number } };
    };
  };
  __player?: {
    play(): void;
    pause(): void;
    seek(time: number): void;
    getTime(): number;
    isPlaying(): boolean;
  };
  __hfWaitForSeekCompletion?: () => Promise<void>;
}

/** Runs inside the opaque preview. The only commands affect its own picture and playback. */
function installPreviewBridge(
  texts: [string, string[]][],
  initialTiming: Pick<PreviewTiming, "structure" | "revision"> & {
    clips: { id: string }[];
  },
) {
  let timingRevision = initialTiming.revision;
  let updatingTiming = false;
  const sourceTexts = new Map(texts);
  const clipElement = (id: string) =>
    document.querySelector(`[data-hf-cutroom-clip-id="${CSS.escape(id)}"]`);
  const win = window as PreviewWindow;
  const positions = new Map<
    HTMLElement | SVGElement,
    { translate: string; priority: string; base: string; x: number; y: number }
  >();
  let positionFrame = 0;
  let positionDraft: {
    clipId: string;
    x: number | null;
    y: number | null;
  } | null = null;
  const splitTranslate = (value: string) => {
    const parts: string[] = [];
    let depth = 0;
    let part = "";
    for (const char of value) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (/\s/.test(char) && depth === 0) {
        if (part) parts.push(part);
        part = "";
      } else part += char;
    }
    if (part) parts.push(part);
    return parts;
  };
  const writePosition = () => {
    positionFrame = 0;
    const draft = positionDraft;
    if (!draft) return;
    const element = clipElement(draft.clipId);
    if (!(element instanceof HTMLElement || element instanceof SVGElement))
      return;
    let original = positions.get(element);
    if (!original) {
      win.gsap?.getProperty(element, "x");
      const number = (name: string) =>
        Number.parseFloat(element.getAttribute(name) ?? "0") || 0;
      original = {
        translate: element.style.getPropertyValue("translate"),
        priority: element.style.getPropertyPriority("translate"),
        base: getComputedStyle(element).translate,
        x: element.hasAttribute("data-hf-edit-base-x")
          ? number("data-x") - number("data-hf-edit-base-x")
          : 0,
        y: element.hasAttribute("data-hf-edit-base-y")
          ? number("data-y") - number("data-hf-edit-base-y")
          : 0,
      };
      positions.set(element, original);
    }
    let translate = original.translate;
    if (draft.x !== null && draft.y !== null) {
      const parts = splitTranslate(
        original.base === "none" ? "" : original.base,
      );
      translate = `calc(${parts[0] ?? "0px"} + ${draft.x - original.x}px) calc(${parts[1] ?? "0px"} + ${draft.y - original.y}px)${parts[2] ? ` ${parts[2]}` : ""}`;
    }
    // The parked video is represented by its held canvas. Both share the same style.
    element.style.setProperty("translate", translate, original.priority);
    if (element instanceof HTMLVideoElement)
      holds
        .get(element)
        ?.canvas.style.setProperty("translate", translate, original.priority);
    if (draft.x === null) positions.delete(element);
    scheduleBox();
    clearTimeout(observationTimer);
    if (observedClip)
      observationTimer = window.setTimeout(scheduleObservation, 350);
  };
  let observedClip: string | null = null;
  let observedText: string | null = null;
  const checkText = () => {
    if (!observedClip || observedText === null) return;
    // A saved edit can be observed before its replacement document is promoted. Only compare
    // against the document containing that source, never the held picture of an earlier edit.
    if (!sourceTexts.get(observedClip)?.includes(observedText)) return;
    const element = clipElement(observedClip);
    if (!element) return;
    // Read the painted text nodes rather than innerText's CSS text-transform result: a
    // capitalized title still contains the committed words. Keep authored <br> boundaries.
    const preserveLines = /^(?:pre|pre-wrap|pre-line|break-spaces)$/.test(
      getComputedStyle(element).whiteSpace,
    );
    const words = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue ?? "";
        return preserveLines ? text : text.replace(/[\t\n\f\r ]+/g, " ");
      }
      if (node instanceof HTMLElement && node.tagName === "BR") return "\n";
      return [...node.childNodes].map(words).join("");
    };
    const rendered = words(element)
      .split(/\r\n?|\n/)
      .map((line) => line.replace(/[\t\f ]+/g, " ").replace(/^ | $/g, ""))
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
    parent.postMessage(
      {
        source: "cutroom-preview",
        type: "text-warning",
        clipId: observedClip,
        text: observedText,
        time: win.__player?.getTime() ?? 0,
        overridden:
          element.checkVisibility({ checkVisibilityCSS: true }) &&
          rendered !== observedText,
      },
      "*",
    );
  };
  let observationTimer = 0;
  let observingPosition = false;
  let observationFrame = 0;
  let foldedClip: string | null = null;
  // This self-contained iframe script cannot import core's composeTranslate and its
  // private helpers. Compare the same baseline + pixel delta as numeric CSS sums,
  // preserving percentages, without adding a layout probe to the document.
  const translateMatches = (
    original: string,
    x: number,
    y: number,
    actual: string,
    style: CSSStyleDeclaration,
  ) => {
    const baseline = splitTranslate(original === "none" ? "" : original);
    const current = splitTranslate(actual === "none" ? "" : actual);
    const lengths = (value: string) => {
      const result = new Map<string, number>();
      for (const term of win.CSSNumericValue.parse(value).toSum().values) {
        let { unit, value } = term;
        if (unit === "em" || unit === "rem") {
          value *= Number.parseFloat(
            unit === "em"
              ? style.fontSize
              : getComputedStyle(document.documentElement).fontSize,
          );
          unit = "px";
        }
        result.set(unit, (result.get(unit) ?? 0) + value);
      }
      return result;
    };
    try {
      return [x, y, 0].every((delta, axis) => {
        const expected = lengths(baseline[axis] ?? "0px");
        expected.set("px", (expected.get("px") ?? 0) + delta);
        const rendered = lengths(current[axis] ?? "0px");
        return [...new Set([...expected.keys(), ...rendered.keys()])].every(
          (unit) =>
            Math.abs((expected.get(unit) ?? 0) - (rendered.get(unit) ?? 0)) <
            0.0001,
        );
      });
    } catch {
      // CSS math that Typed OM cannot resolve is not evidence that Position holds.
      return false;
    }
  };
  const checkPosition = (foldedId?: string | null) => {
    observingPosition = false;
    if (!observedClip) return;
    performance.mark("cutroom:position-observation:start");
    try {
      const element = clipElement(observedClip);
      if (!(element instanceof HTMLElement || element instanceof SVGElement))
        return;
      const number = (name: string) =>
        Number.parseFloat(element.getAttribute(name) ?? "0") || 0;
      const draft =
        positionDraft?.clipId === observedClip ? positionDraft : null;
      const edited =
        element.hasAttribute("data-hf-edit-base-x") ||
        element.hasAttribute("data-hf-edit-base-y");
      const x =
        draft?.x ??
        (edited ? number("data-x") - number("data-hf-edit-base-x") : 0);
      const y =
        draft?.y ??
        (edited ? number("data-y") - number("data-hf-edit-base-y") : 0);
      observingPosition = Boolean(x || y);
      let overridden = false;
      const picture =
        element instanceof HTMLVideoElement
          ? (holds.get(element)?.canvas ?? element)
          : element;
      if ((x || y) && picture.checkVisibility({ checkVisibilityCSS: true })) {
        const style = getComputedStyle(picture);
        const saved = positions.get(element);
        const original =
          saved?.base ??
          element.getAttribute("data-hf-edit-original-translate") ??
          "none";
        const dx = saved ? x - saved.x : x;
        const dy = saved ? y - saved.y : y;
        overridden = !translateMatches(
          original,
          dx,
          dy,
          style.translate,
          style,
        );
        if (foldedId && element.getAttribute("data-hf-id") === foldedId)
          overridden = true;
        // `translate` composes outside the clip's own scale, rotate and transform, so only
        // zoom on the clip itself changes the offset; any ancestor transform does too.
        overridden ||=
          style.zoom !== "normal" &&
          Math.abs(Number.parseFloat(style.zoom) - 1) > 0.000001;
        for (
          let ancestor = picture.parentElement;
          ancestor && !overridden;
          ancestor = ancestor.parentElement
        ) {
          const css = getComputedStyle(ancestor);
          const matrix = new DOMMatrixReadOnly(
            css.transform === "none" ? undefined : css.transform,
          );
          const linear = [
            matrix.m11 - 1,
            matrix.m12,
            matrix.m13,
            matrix.m14,
            matrix.m21,
            matrix.m22 - 1,
            matrix.m23,
            matrix.m24,
            matrix.m31,
            matrix.m32,
            matrix.m33 - 1,
            matrix.m34,
            matrix.m44 - 1,
          ];
          overridden =
            linear.some((value) => Math.abs(value) > 0.000001) ||
            (css.zoom !== "normal" &&
              Math.abs(Number.parseFloat(css.zoom) - 1) > 0.000001) ||
            (css.scale !== "none" &&
              css.scale
                .split(/\s+/)
                .some(
                  (value) =>
                    Math.abs(
                      Number.parseFloat(value) /
                        (value.endsWith("%") ? 100 : 1) -
                        1,
                    ) > 0.000001,
                )) ||
            (css.rotate !== "none" &&
              Math.abs(
                Number.parseFloat(css.rotate.split(/\s+/).at(-1)!) % 360,
              ) > 0.000001);
        }
      }
      parent.postMessage(
        {
          source: "cutroom-preview",
          type: "position-warning",
          clipId: observedClip,
          time: win.__player?.getTime() ?? 0,
          overridden,
        },
        "*",
      );
    } finally {
      performance.measure(
        "cutroom:position-observation",
        "cutroom:position-observation:start",
      );
      performance.clearMarks("cutroom:position-observation:start");
      performance.clearMeasures("cutroom:position-observation");
    }
  };
  const scheduleObservation = (foldedId?: string | null) => {
    if (foldedId) foldedClip = foldedId;
    if (!observedClip) {
      cancelAnimationFrame(observationFrame);
      observationFrame = 0;
      clearTimeout(observationTimer);
      observingPosition = false;
      foldedClip = null;
      return;
    }
    if (observationFrame) return;
    const frame = requestAnimationFrame(() => {
      const version = pictureVersion;
      void picture.then(
        () => {
          if (observationFrame !== frame) return;
          observationFrame = 0;
          // Check again after a newer seek settles, or after a draft still waiting for its
          // frame reaches the picture: until then the draft and the picture disagree.
          if (version !== pictureVersion || positionFrame) {
            scheduleObservation();
            return;
          }
          checkText();
          checkPosition(foldedClip);
          foldedClip = null;
          observePlaying();
        },
        () => {
          // The owning seek/paint request reports picture failures.
          if (observationFrame === frame) observationFrame = 0;
        },
      );
    });
    observationFrame = frame;
  };
  const observePlaying = () => {
    clearTimeout(observationTimer);
    if (
      !observedClip ||
      (!observingPosition && observedText === null) ||
      !win.__player?.isPlaying()
    )
      return;
    observationTimer = window.setTimeout(() => {
      scheduleObservation();
    }, 350);
  };
  type Box = { x: number; y: number; width: number; height: number };
  /** A clip's box in composition pixels: the iframe's viewport is the composition's frame. */
  const boxOf = (element: Element): Box | null => {
    const picture =
      element instanceof HTMLVideoElement
        ? (holds.get(element)?.canvas ?? element)
        : element;
    if (!picture.checkVisibility({ checkVisibilityCSS: true })) return null;
    let { left, top, right, bottom } = picture.getBoundingClientRect();
    if (right <= left || bottom <= top) {
      // A clip that only positions its children has no box of its own.
      left = top = Infinity;
      right = bottom = -Infinity;
      for (const child of picture.querySelectorAll("*")) {
        const rect = child.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
      }
      if (right <= left) return null;
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  };
  let postedBox = "";
  /** Tells the editor where the observed clip is. Only a moved or resized box is sent. */
  const postBox = () => {
    if (!observedClip) return;
    const start = performance.now();
    const box = boxElement ? boxOf(boxElement) : null;
    performance.measure("cutroom:clip-box", { start, end: performance.now() });
    performance.clearMeasures("cutroom:clip-box");
    const key = box
      ? `${observedClip} ${box.x} ${box.y} ${box.width} ${box.height}`
      : observedClip;
    if (key === postedBox) return;
    postedBox = key;
    parent.postMessage(
      {
        source: "cutroom-preview",
        type: "clip-box",
        clipId: observedClip,
        box,
      },
      "*",
    );
  };
  let boxFrame = 0;
  let boxElement: Element | null = null;
  let boxAnimations: Animation[] = [];
  const scheduleBox = () => {
    if (observedClip && !boxFrame) boxFrame = requestAnimationFrame(followBox);
  };
  // Only CSS/Web Animations need continuous reads. GSAP and script changes invalidate the
  // cached box through mutations, so a stationary clip does no work per playback frame.
  const refreshBoxAnimations = () => {
    boxAnimations = boxElement?.getAnimations({ subtree: true }) ?? [];
    for (
      let ancestor = boxElement?.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    )
      boxAnimations.push(...ancestor.getAnimations());
    scheduleBox();
  };
  const followBox = () => {
    const frame = boxFrame;
    const version = pictureVersion;
    // A seek may still be replacing the held video. Read the settled picture once, with
    // the other geometry reads, instead of flushing layout between its style writes.
    void picture.then(
      () => {
        if (boxFrame !== frame) return;
        boxFrame = 0;
        if (version !== pictureVersion || positionFrame) {
          scheduleBox();
          return;
        }
        postBox();
        if (
          boxAnimations.some((animation) => animation.playState === "running")
        )
          scheduleBox();
      },
      () => {
        // The owning seek/paint request reports picture failures.
        if (boxFrame === frame) boxFrame = 0;
      },
    );
  };
  const boxMutations = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          record.type !== "attributes" ||
          record.oldValue !==
            (record.target as Element).getAttribute(record.attributeName!),
      )
    )
      scheduleBox();
  });
  const boxResize = new ResizeObserver(scheduleBox);
  const observeBox = () => {
    boxMutations.disconnect();
    boxResize.disconnect();
    cancelAnimationFrame(boxFrame);
    boxFrame = 0;
    boxAnimations = [];
    boxElement = observedClip ? clipElement(observedClip) : null;
    if (!boxElement) {
      scheduleBox();
      return;
    }
    boxMutations.observe(boxElement, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      childList: true,
      characterData: true,
    });
    boxResize.observe(boxElement);
    for (
      let ancestor = boxElement.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    )
      boxMutations.observe(ancestor, {
        attributes: true,
        attributeOldValue: true,
      });
    refreshBoxAnimations();
  };
  // Delayed CSS animations and transitions can start without changing an inline attribute.
  for (const event of [
    "animationstart",
    "animationend",
    "animationcancel",
    "transitionrun",
    "transitionend",
    "transitioncancel",
  ])
    document.addEventListener(
      event,
      (event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          boxElement &&
          (boxElement.contains(target) || target.contains(boxElement))
        )
          refreshBoxAnimations();
      },
      true,
    );
  addEventListener("resize", scheduleBox);
  /** Recover local border coordinates from the complete affine transform, including ancestors.
   * Layout offsets and transform origins only translate the quad; its bounding box anchors it.
   */
  const localPoint = (
    element: Element,
    x: number,
    y: number,
    styleOf: (element: Element) => CSSStyleDeclaration,
  ) => {
    const style = styleOf(element);
    const number = (name: string) =>
      Number.parseFloat(style.getPropertyValue(name)) || 0;
    const extra = (axis: "width" | "height") =>
      style.boxSizing === "border-box"
        ? 0
        : (axis === "width" ? ["left", "right"] : ["top", "bottom"]).reduce(
            (sum, side) =>
              sum + number(`padding-${side}`) + number(`border-${side}-width`),
            0,
          );
    const width = number("width") + extra("width");
    const height = number("height") + extra("height");
    let matrix = new DOMMatrix();
    for (let node: Element | null = element; node; node = node.parentElement) {
      const css = styleOf(node);
      let transform = new DOMMatrix(
        css.transform === "none" ? undefined : css.transform,
      );
      if (css.scale !== "none") {
        const scales = css.scale
          .split(/\s+/)
          .map(
            (value) =>
              Number.parseFloat(value) / (value.endsWith("%") ? 100 : 1),
          );
        transform = new DOMMatrix()
          .scale(scales[0]!, scales[1] ?? scales[0]!)
          .multiply(transform);
      }
      if (css.rotate !== "none") {
        const angle = css.rotate.split(/\s+/).at(-1)!;
        const degrees =
          Number.parseFloat(angle) *
          (angle.endsWith("grad")
            ? 0.9
            : angle.endsWith("rad")
              ? 180 / Math.PI
              : angle.endsWith("turn")
                ? 360
                : 1);
        transform = new DOMMatrix().rotate(degrees).multiply(transform);
      }
      const zoom = css.zoom === "normal" ? 1 : Number.parseFloat(css.zoom);
      matrix = new DOMMatrix().scale(zoom).multiply(transform).multiply(matrix);
    }
    // Translations are supplied by the painted rect, so retain only the combined linear part.
    const linear = new DOMMatrix([
      matrix.a,
      matrix.b,
      matrix.c,
      matrix.d,
      0,
      0,
    ]);
    const corners = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ].map(([x, y]) => linear.transformPoint({ x, y }));
    const rect = element.getBoundingClientRect();
    const point = linear.inverse().transformPoint({
      x: x - rect.left + Math.min(...corners.map((point) => point.x)),
      y: y - rect.top + Math.min(...corners.map((point) => point.y)),
    });
    return { x: point.x, y: point.y, width, height };
  };
  const paintsAt = (
    element: Element,
    x: number,
    y: number,
    styleOf: (element: Element) => CSSStyleDeclaration,
  ) => {
    if (!element.checkVisibility({ checkOpacity: true })) return false;
    if (
      element instanceof HTMLImageElement ||
      element instanceof HTMLVideoElement ||
      element instanceof HTMLCanvasElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLButtonElement ||
      (element instanceof SVGElement && !(element instanceof SVGSVGElement))
    )
      return true;
    for (const pseudo of [undefined, "::before", "::after"]) {
      const style = pseudo
        ? getComputedStyle(element, pseudo)
        : styleOf(element);
      if (pseudo && (style.content === "none" || style.content === "normal"))
        continue;
      if (
        style.backgroundImage !== "none" ||
        !/^(?:transparent|rgba\(.+,\s*0\)|.+\/\s*0\))$/.test(
          style.backgroundColor,
        )
      )
        return true;
      // A transparent box can still paint its border. Its empty centre stays click-through.
      if (!pseudo) {
        const borders = ["left", "right", "top", "bottom"].flatMap((side) => {
          const width = Number.parseFloat(
            style.getPropertyValue(`border-${side}-width`),
          );
          return width > 0 &&
            !["none", "hidden"].includes(
              style.getPropertyValue(`border-${side}-style`),
            ) &&
            !/^(?:transparent|rgba\(.+,\s*0\)|.+\/\s*0\))$/.test(
              style.getPropertyValue(`border-${side}-color`),
            )
            ? [{ side, width }]
            : [];
        });
        if (borders.length) {
          const point = localPoint(element, x, y, styleOf);
          if (
            point.x >= 0 &&
            point.x <= point.width &&
            point.y >= 0 &&
            point.y <= point.height
          )
            for (const { side, width } of borders) {
              const distance =
                side === "left"
                  ? point.x
                  : side === "right"
                    ? point.width - point.x
                    : side === "top"
                      ? point.y
                      : point.height - point.y;
              if (distance <= width) return true;
            }
        }
      }
    }
    const range = document.createRange();
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue?.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects())
        if (
          x >= rect.left &&
          x < rect.right &&
          y >= rect.top &&
          y < rect.bottom
        )
          return true;
    }
    return false;
  };
  /**
   * The clips under a point, topmost first, as the timeline names them: the outermost timed
   * element inside the root. `painted` is false where only a clip's empty box covers the point.
   */
  const clipsAt = (x: number, y: number) => {
    const root = document.querySelector("[data-composition-id]");
    const hits = new Map<Element, boolean>();
    const styles = new Map<Element, CSSStyleDeclaration>();
    const styleOf = (element: Element) => {
      let style = styles.get(element);
      if (!style) {
        style = getComputedStyle(element);
        styles.set(element, style);
      }
      return style;
    };
    // Only the editor requests hits. Restore authored styles synchronously, before any
    // composition script, observer, paint or capture can see a different pointer-events value.
    const overrides: {
      element: HTMLElement | SVGElement;
      style: string | null;
    }[] = [];
    try {
      // Most timeline clips are display:none. Only inspect styles on the visible tree, and
      // override only elements whose authored pointer-events would hide them from the hit test.
      // This avoids invalidating styles on all 500 clips twice for every press.
      for (const element of root?.querySelectorAll("*") ?? []) {
        if (
          !(element instanceof HTMLElement || element instanceof SVGElement) ||
          !element.checkVisibility({ checkVisibilityCSS: true }) ||
          styleOf(element).pointerEvents !== "none"
        )
          continue;
        overrides.push({
          element,
          style: element.getAttribute("style"),
        });
      }
      for (const { element } of overrides)
        element.style.setProperty("pointer-events", "auto", "important");
      for (const element of document.elementsFromPoint(x, y)) {
        if (!root?.contains(element) || element === root) continue;
        if (element.hasAttribute("data-cutroom-edit-frame")) continue;
        const source = element.hasAttribute("data-cutroom-video-hold")
          ? element.previousElementSibling
          : element;
        const clip = source?.closest("[data-hf-cutroom-clip-id]");
        if (!clip) continue;
        hits.set(clip, hits.get(clip) || paintsAt(element, x, y, styleOf));
      }
      return [...hits].flatMap(([clip, painted]) => {
        const box = boxOf(clip);
        return box
          ? [
              {
                clipId: clip.getAttribute("data-hf-cutroom-clip-id")!,
                painted,
                box,
              },
            ]
          : [];
      });
    } finally {
      for (const { element, style } of overrides)
        if (style === null) element.removeAttribute("style");
        else element.setAttribute("style", style);
    }
  };
  let metering = false;
  let animation = 0;
  const levels = () => {
    if (!metering) return;
    const meter = win.__hf?.audioMeter;
    meter?.start();
    const level = win.__player?.isPlaying() ? meter?.read().master : null;
    if (win.__player?.isPlaying())
      parent.postMessage(
        {
          source: "cutroom-preview",
          type: "clock",
          time: win.__player.getTime(),
          at: performance.timeOrigin + performance.now(),
        },
        "*",
      );
    parent.postMessage(
      {
        source: "cutroom-preview",
        type: "levels",
        playing: Boolean(win.__player?.isPlaying()),
        l: level?.l ?? 0,
        r: level?.r ?? 0,
      },
      "*",
    );
    if (win.__player?.isPlaying()) animation = requestAnimationFrame(levels);
    else {
      animation = 0;
      meter?.stop();
    }
  };
  const state = () => {
    const root = document.querySelector("[data-composition-id]");
    const size = (name: string, fallback: number) => {
      const value = Number(root?.getAttribute(name));
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
      ready: Boolean(win.__player),
      root: Boolean(root),
      error: win.__hfStartupError
        ? (win.__cutroomReadDiagnostics?.() ?? [])
            .map(({ file, message }) => `${file}: ${message}`)
            .join("\n") || String(win.__hfStartupError)
        : null,
      width: size("data-width", 1920),
      height: size("data-height", 1080),
      fps: root?.getAttribute("data-fps") ?? null,
      time: Number(win.__player?.getTime() ?? 0),
      playing: Boolean(win.__player?.isPlaying()),
    };
  };
  const reply = (
    id?: string,
    error?: string,
    hits?: ReturnType<typeof clipsAt>,
  ) => {
    const diagnostics = win.__cutroomReadDiagnostics?.();
    parent.postMessage(
      {
        source: "cutroom-preview",
        id,
        state: state(),
        timingRevision,
        error,
        hits,
        ...(diagnostics?.length ? { diagnostics } : {}),
      },
      "*",
    );
  };
  const paint = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  const holds = new Map<
    HTMLVideoElement,
    {
      canvas: HTMLCanvasElement;
      frame: VideoFrame;
      display: string;
      callback?: number;
      timer?: number;
    }
  >();
  const FRAME_TIMEOUT = 8_000;
  let retired = false;
  let pictureVersion = 0;
  let picture = Promise.resolve();
  let editCanvas: HTMLCanvasElement | null = null;
  let editFrames: VideoFrame[] = [];
  const editPreloads = new Map<HTMLVideoElement, string | null>();
  const clearEditPicture = () => {
    editCanvas?.remove();
    editCanvas = null;
    for (const frame of editFrames) frame.close();
    editFrames = [];
    for (const [video, preload] of editPreloads) {
      if (preload === null) video.removeAttribute("preload");
      else video.setAttribute("preload", preload);
    }
    editPreloads.clear();
  };
  const showEditPicture = async (edges: EditFrame[], version: number) => {
    // Reuse the document's source elements, even beyond their saved trim windows.
    // The runtime is paused; its normal seek restores all media on release.
    await win.__hfWaitForSeekCompletion?.();
    const deadline = performance.now() + FRAME_TIMEOUT;
    const sources = await Promise.all(
      edges.map(async (edge) => {
        const element = clipElement(edge.clipId);
        if (!(
          element instanceof HTMLVideoElement ||
          element instanceof HTMLImageElement
        ))
          throw new Error(
            `The preview cannot show the edit frame for ${edge.clipId}.`,
          );
        if (element instanceof HTMLVideoElement) {
          element.pause();
          if (!editPreloads.has(element))
            editPreloads.set(element, element.getAttribute("preload"));
          element.preload = "auto";
          if (!element.readyState) element.load();
          while (!element.readyState) {
            if (retired || version !== pictureVersion) return element;
            if (element.error) throw new Error(element.error.message);
            if (performance.now() > deadline)
              throw new Error(
                "The preview did not load the edit source in time.",
              );
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
          }
          // Match the runtime's media-element lead, avoiding a decode on the preceding
          // frame when an exact rational boundary rounds down in the native decoder.
          element.currentTime = edge.time + 0.00001;
        }
        return element;
      }),
    );
    const frames: (VideoFrame | HTMLImageElement)[] = [];
    try {
      for (;;) {
        if (retired || version !== pictureVersion) return;
        if (performance.now() > deadline)
          throw new Error("The preview did not draw the edit frame in time.");
        if (
          sources.some((source) =>
            source instanceof HTMLVideoElement
              ? source.seeking || source.readyState < 2
              : !source.complete || !source.naturalWidth,
          )
        ) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          continue;
        }
        try {
          for (const source of sources)
            frames.push(
              source instanceof HTMLVideoElement
                ? new VideoFrame(source)
                : source,
            );
          break;
        } catch (error) {
          for (const frame of frames)
            if (frame instanceof VideoFrame) frame.close();
          frames.length = 0;
          if (!(
            error instanceof DOMException && error.name === "InvalidStateError"
          ))
            throw error;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        }
      }
      const { width, height } = state();
      const canvas = editCanvas ?? document.createElement("canvas");
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.dataset.cutroomEditFrame = "";
      canvas.dataset.count = String(frames.length);
      canvas.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;z-index:2147483647;pointer-events:none";
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("The preview could not hold the edit frame.");
      context.fillRect(0, 0, width, height);
      frames.forEach((frame, index) => {
        const w =
          frame instanceof VideoFrame ? frame.displayWidth : frame.naturalWidth;
        const h =
          frame instanceof VideoFrame
            ? frame.displayHeight
            : frame.naturalHeight;
        const panel = width / frames.length;
        const scale = Math.min(panel / w, height / h);
        context.drawImage(
          frame,
          index * panel + (panel - w * scale) / 2,
          (height - h * scale) / 2,
          w * scale,
          h * scale,
        );
      });
      if (!editCanvas) document.body.append(canvas);
      editCanvas = canvas;
      for (const frame of editFrames) frame.close();
      editFrames = frames.filter(
        (frame): frame is VideoFrame => frame instanceof VideoFrame,
      );
      frames.length = 0;
    } finally {
      for (const frame of frames)
        if (frame instanceof VideoFrame) frame.close();
    }
  };
  const holdStyle = document.createElement("style");
  holdStyle.textContent =
    "video[data-cutroom-held] { visibility: hidden !important; }" +
    "video[data-cutroom-held][data-cutroom-flow] { position: absolute !important; }";
  document.head.append(holdStyle);
  const cancelRelease = (video: HTMLVideoElement) => {
    const hold = holds.get(video);
    if (!hold) return;
    if (hold.callback !== undefined)
      video.cancelVideoFrameCallback(hold.callback);
    clearTimeout(hold.timer);
    delete hold.callback;
    delete hold.timer;
  };
  const removeHold = (video: HTMLVideoElement) => {
    cancelRelease(video);
    const hold = holds.get(video);
    hold?.canvas.remove();
    hold?.frame.close();
    holds.delete(video);
    video.removeAttribute("data-cutroom-held");
    video.removeAttribute("data-cutroom-flow");
  };
  const captureFrames = (videos: HTMLVideoElement[]) => {
    const frames = new Map<HTMLVideoElement, VideoFrame>();
    try {
      for (const video of videos) frames.set(video, new VideoFrame(video));
      return frames;
    } catch (error) {
      for (const frame of frames.values()) frame.close();
      if (error instanceof DOMException && error.name === "InvalidStateError")
        return null;
      throw error;
    }
  };
  const holdPaused = async (version: number) => {
    const waitForSeek = win.__hfWaitForSeekCompletion;
    if (typeof waitForSeek !== "function")
      throw new Error("The preview cannot confirm that it drew the frame.");
    let timer = 0;
    try {
      await Promise.race([
        (async () => {
          await waitForSeek();
          for (;;) {
            if (version !== pictureVersion || win.__player?.isPlaying()) return;
            // Read authored visibility without our native-surface suppression.
            for (const video of holds.keys()) {
              video.removeAttribute("data-cutroom-held");
            }
            const videos = Array.from(
              document.querySelectorAll("video"),
            ).filter((video) =>
              video.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              }),
            );
            for (const video of holds.keys()) {
              video.setAttribute("data-cutroom-held", "");
            }
            const failed = videos.find((video) => video.error);
            if (failed)
              throw new Error(
                `The preview could not load ${failed.getAttribute("src")}.`,
              );
            if (videos.some((video) => video.readyState < 2 || video.seeking)) {
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              continue;
            }
            // A native element can paint nothing despite reporting HAVE_CURRENT_DATA.
            // Acquire every decoded frame before replacing any displayed picture.
            const frames = captureFrames(videos);
            if (!frames) {
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              continue;
            }
            try {
              for (const [video] of holds) {
                if (!videos.includes(video)) removeHold(video);
              }
              for (const [video, frame] of frames) {
                cancelRelease(video);
                const previous = holds.get(video);
                video.removeAttribute("data-cutroom-held");
                try {
                  const style = getComputedStyle(video);
                  const canvas =
                    previous?.canvas ?? document.createElement("canvas");
                  canvas.setAttribute("data-cutroom-video-hold", "");
                  for (const name of style)
                    canvas.style.setProperty(
                      name,
                      style.getPropertyValue(name),
                    );
                  // Keep the source aspect ratio so the browser applies object-fit and
                  // object-position exactly as it does to the replaced video element.
                  let a = video.videoWidth;
                  let b = video.videoHeight;
                  while (b) [a, b] = [b, a % b];
                  const unitWidth = video.videoWidth / a;
                  const unitHeight = video.videoHeight / a;
                  const scale = Math.min(
                    a,
                    Math.max(
                      1,
                      Math.ceil(
                        devicePixelRatio *
                          Math.max(
                            video.clientWidth / unitWidth,
                            video.clientHeight / unitHeight,
                          ),
                      ),
                    ),
                  );
                  const width =
                    style.objectFit === "none"
                      ? video.videoWidth
                      : unitWidth * scale;
                  const height =
                    style.objectFit === "none"
                      ? video.videoHeight
                      : unitHeight * scale;
                  if (canvas.width !== width) canvas.width = width;
                  if (canvas.height !== height) canvas.height = height;
                  if (
                    style.position === "absolute" ||
                    style.position === "fixed"
                  ) {
                    canvas.style.right = "auto";
                    canvas.style.bottom = "auto";
                  } else {
                    // The canvas takes the video's place in flow, including flex/grid
                    // layout and paint order. The hidden native video keeps decoding.
                    video.setAttribute("data-cutroom-flow", "");
                  }
                  canvas.style.pointerEvents = "none";
                  canvas.style.animation = "none";
                  canvas.style.transition = "none";
                  const context = canvas.getContext("2d");
                  if (!context)
                    throw new Error(
                      "The preview could not hold the video frame.",
                    );
                  context.clearRect(0, 0, canvas.width, canvas.height);
                  context.drawImage(frame, 0, 0, canvas.width, canvas.height);
                  if (video.nextElementSibling !== canvas) video.after(canvas);
                  previous?.frame.close();
                  holds.set(video, {
                    canvas,
                    frame,
                    display: canvas.style.display,
                  });
                  frames.delete(video);
                } finally {
                  const hold = holds.get(video);
                  if (hold) {
                    video.setAttribute("data-cutroom-held", "");
                    hold.canvas.style.setProperty("display", hold.display);
                  }
                }
              }
            } finally {
              for (const frame of frames.values()) frame.close();
            }
            return;
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () =>
              reject(new Error("The preview did not draw the frame in time.")),
            FRAME_TIMEOUT,
          );
        }),
      ]);
    } catch (error) {
      if (version !== pictureVersion) return;
      pictureVersion += 1;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const refreshPicture = () => {
    const version = ++pictureVersion;
    for (const video of holds.keys()) cancelRelease(video);
    picture = holdPaused(version);
    return picture;
  };
  const releasePlaying = (video: HTMLVideoElement) => {
    const hold = holds.get(video);
    if (!hold || hold.callback !== undefined) return;
    hold.callback = video.requestVideoFrameCallback(() => {
      delete hold.callback;
      if (!video.paused && win.__player?.isPlaying()) removeHold(video);
    });
    hold.timer = window.setTimeout(() => {
      cancelRelease(video);
      reply(undefined, "The preview did not supply a playback frame in time.");
    }, FRAME_TIMEOUT);
  };
  document.addEventListener(
    "play",
    (event) => {
      if (!retired && event.target instanceof HTMLVideoElement)
        releasePlaying(event.target);
    },
    true,
  );
  addEventListener("pagehide", () => {
    retired = true;
    parent.postMessage({ source: "cutroom-preview", type: "unloaded" }, "*");
    pictureVersion += 1;
    clearTimeout(observationTimer);
    cancelAnimationFrame(observationFrame);
    observationFrame = 0;
    cancelAnimationFrame(boxFrame);
    boxFrame = 0;
    boxMutations.disconnect();
    boxResize.disconnect();
    // The parent compositor can still show this document while retiring its iframe.
    // Release decoding resources without erasing the last painted picture.
    for (const frame of editFrames) frame.close();
    editFrames = [];
    for (const [video, hold] of holds) {
      cancelRelease(video);
      hold.frame.close();
    }
    holds.clear();
    for (const media of document.querySelectorAll<HTMLMediaElement>(
      "video, audio",
    )) {
      media.pause();
      media.removeAttribute("src");
      media.load();
    }
  });
  addEventListener("message", (event: MessageEvent<unknown>) => {
    if (
      retired ||
      event.source !== parent ||
      !event.data ||
      typeof event.data !== "object"
    )
      return;
    const data = event.data;
    if (
      !("source" in data) ||
      data.source !== "cutroom-viewer" ||
      !("id" in data) ||
      typeof data.id !== "string" ||
      !("action" in data)
    )
      return;
    const id = data.id;
    void (async () => {
      switch (data.action) {
        case "observe-position":
          if (
            !("clipId" in data) ||
            !(data.clipId === null || typeof data.clipId === "string")
          )
            return;
          if (
            !("text" in data) ||
            !(data.text === null || typeof data.text === "string")
          )
            return;
          observedClip = data.clipId;
          observedText = data.text;
          postedBox = "";
          observeBox();
          scheduleObservation();
          break;
        case "hit":
          if (
            !("x" in data) ||
            typeof data.x !== "number" ||
            !Number.isFinite(data.x) ||
            !("y" in data) ||
            typeof data.y !== "number" ||
            !Number.isFinite(data.y)
          )
            return;
          {
            const start = performance.now();
            const hits = clipsAt(data.x, data.y);
            performance.measure("cutroom:picture-hit", {
              start,
              end: performance.now(),
            });
            performance.clearMeasures("cutroom:picture-hit");
            reply(id, undefined, hits);
          }
          return;
        case "position-fold":
          if (
            "hfId" in data &&
            (data.hfId === null || typeof data.hfId === "string")
          )
            scheduleObservation(data.hfId);
          return;
        case "position":
          if (
            !("clipId" in data) ||
            typeof data.clipId !== "string" ||
            !("x" in data) ||
            !("y" in data) ||
            !(
              data.x === null ||
              (typeof data.x === "number" && Number.isFinite(data.x))
            ) ||
            !(
              data.y === null ||
              (typeof data.y === "number" && Number.isFinite(data.y))
            )
          )
            return;
          positionDraft = { clipId: data.clipId, x: data.x, y: data.y };
          if (!positionFrame)
            positionFrame = requestAnimationFrame(writePosition);
          return;
        case "timing": {
          if (updatingTiming || win.__player?.isPlaying() || !win.__player)
            throw new Error("Timing updates require a paused preview.");
          if (
            !("timing" in data) ||
            !data.timing ||
            typeof data.timing !== "object" ||
            !("expectedRevision" in data) ||
            data.expectedRevision !== timingRevision ||
            !("time" in data) ||
            typeof data.time !== "number" ||
            !Number.isFinite(data.time) ||
            data.time < 0
          )
            throw new Error("The preview timing revision changed.");
          // The parent validates the server snapshot. Check again at the isolated boundary,
          // then resolve every target before changing any linked partner.
          const timing = data.timing;
          if (
            !("structure" in timing) ||
            timing.structure !== initialTiming.structure ||
            !("revision" in timing) ||
            typeof timing.revision !== "string" ||
            !("clips" in timing) ||
            !Array.isArray(timing.clips) ||
            timing.clips.length !== initialTiming.clips.length
          )
            throw new Error("The preview document changed.");
          const writes: {
            element: Element;
            values: [string, string | null][];
          }[] = [];
          const elements = new Map<string, Element>();
          for (const element of document.querySelectorAll(
            "[data-hf-cutroom-clip-id]",
          )) {
            const id = element.getAttribute("data-hf-cutroom-clip-id")!;
            if (elements.has(id))
              throw new Error("The preview clip is ambiguous.");
            elements.set(id, element);
          }
          const attributes = [
            "data-start",
            "data-duration",
            "data-end",
            "data-media-start",
            "data-playback-start",
            "data-playback-rate",
          ];
          const clips: unknown[] = timing.clips;
          for (const [index, clip] of clips.entries()) {
            if (
              !clip ||
              typeof clip !== "object" ||
              !("id" in clip) ||
              typeof clip.id !== "string" ||
              clip.id !== initialTiming.clips[index]?.id ||
              !("values" in clip) ||
              !clip.values ||
              typeof clip.values !== "object"
            )
              throw new Error("The preview clips changed.");
            const element = elements.get(clip.id);
            if (!element) throw new Error("The preview clip is missing.");
            const values: [string, string | null][] = [];
            for (const name of attributes) {
              const value: unknown = Reflect.get(clip.values, name);
              if (
                value !== null &&
                (typeof value !== "string" ||
                  value.trim() === "" ||
                  !Number.isFinite(Number(value)) ||
                  Number(value) < 0)
              )
                throw new Error("Invalid preview timing.");
              values.push([name, value]);
            }
            writes.push({ element, values });
          }
          updatingTiming = true;
          try {
            // Synchronous writes are one MutationObserver batch to the runtime.
            for (const { element, values } of writes)
              for (const [name, value] of values) {
                if (element.getAttribute(name) === value) continue;
                if (value === null) element.removeAttribute(name);
                else element.setAttribute(name, value);
              }
            // Let the runtime invalidate its descriptor cache before seeking.
            await Promise.resolve();
            win.__player.seek(data.time);
            const restored = refreshPicture();
            const version = pictureVersion;
            await restored;
            await paint();
            if (
              retired ||
              version !== pictureVersion ||
              win.__player.isPlaying()
            )
              throw new Error("The preview timing update was superseded.");
            clearEditPicture();
            timingRevision = timing.revision;
            scheduleObservation();
            scheduleBox();
          } finally {
            updatingTiming = false;
          }
          break;
        }
        case "inspect":
          break;
        case "cancel-edit":
          // Let the one pending seek finish without painting a stale edge. The queued
          // playhead seek then restores the picture, even when the source is still loading.
          pictureVersion += 1;
          return;
        case "meter":
          if (!("enabled" in data) || typeof data.enabled !== "boolean") return;
          metering = data.enabled;
          cancelAnimationFrame(animation);
          animation = 0;
          if (metering) levels();
          else win.__hf?.audioMeter?.stop();
          break;
        case "play":
          clearEditPicture();
          pictureVersion += 1;
          for (const video of holds.keys()) releasePlaying(video);
          win.__player?.play();
          observePlaying();
          refreshBoxAnimations();
          if (metering && !animation) levels();
          break;
        case "pause":
          win.__player?.pause();
          cancelAnimationFrame(animation);
          animation = 0;
          if (metering) levels();
          await refreshPicture();
          clearTimeout(observationTimer);
          scheduleObservation();
          scheduleBox();
          break;
        case "seek":
          if (
            !("time" in data) ||
            typeof data.time !== "number" ||
            !Number.isFinite(data.time) ||
            data.time < 0
          )
            return;
          if ("edit" in data && Array.isArray(data.edit) && data.edit.length) {
            const edges: EditFrame[] = [];
            if (data.edit.length > 2) return;
            for (const edge of data.edit) {
              if (
                !edge ||
                typeof edge !== "object" ||
                !("clipId" in edge) ||
                typeof edge.clipId !== "string" ||
                !("time" in edge) ||
                typeof edge.time !== "number" ||
                !Number.isFinite(edge.time) ||
                edge.time < 0
              )
                return;
              edges.push({ clipId: edge.clipId, time: edge.time });
            }
            win.__player?.pause();
            const version = ++pictureVersion;
            picture = showEditPicture(edges, version);
            await picture;
            break;
          }
          win.__player?.seek(data.time);
          if (!win.__player?.isPlaying()) {
            const restored = refreshPicture();
            const version = pictureVersion;
            await restored;
            if (version === pictureVersion) clearEditPicture();
          }
          scheduleObservation();
          scheduleBox();
          break;
        case "mute":
          if (!("muted" in data) || typeof data.muted !== "boolean") return;
          win.postMessage(
            {
              source: "hf-parent",
              type: "control",
              action: "set-muted",
              muted: data.muted,
            },
            "*",
          );
          break;
        case "paint":
          await picture;
          await paint();
          scheduleObservation();
          scheduleBox();
          break;
        default:
          return;
      }
      reply(id);
    })().catch((error: unknown) =>
      reply(id, error instanceof Error ? error.message : String(error)),
    );
  });
}

/** Bind the source timeline's identities before compilation's generated HF ids can rename them.
 * The compiler and this adapter use the same HF stamping function. Our data-hf marker is excluded
 * from its content hash, so it cannot change the runtime's identities or animation targets.
 */
export function withPreviewClipIdentities(
  html: string,
  source = html,
  scope: CompositionScope = "document",
  mediaLengths: ReadonlyMap<string, number> = new Map(),
) {
  let locations: Map<number, string>;
  try {
    locations = compositionClipLocations(source, scope, mediaLengths);
  } catch (error) {
    // Unsupported timelines still have a viewable picture, but no selectable timeline clips.
    if (!(error instanceof TimelineError)) throw error;
    return html;
  }
  const visit = (
    nodes: DefaultTreeAdapterTypes.ChildNode[],
    read: (node: DefaultTreeAdapterTypes.Element) => void,
  ) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      read(node);
      visit(node.childNodes, read);
      if ("content" in node) visit(node.content.childNodes, read);
    }
  };
  const mark = (
    html: string,
    identify: (node: DefaultTreeAdapterTypes.Element) => string | undefined,
  ) => {
    const edits: { at: number; end: number; text: string }[] = [];
    visit(parse(html, { sourceCodeLocationInfo: true }).childNodes, (node) => {
      const id = identify(node);
      const start = node.sourceCodeLocation?.startTag;
      if (!id || !start) return;
      const existing =
        node.sourceCodeLocation?.attrs?.["data-hf-cutroom-clip-id"];
      const at = start.startOffset + node.tagName.length + 1;
      const value = id
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;");
      edits.push({
        at: existing?.startOffset ?? at,
        end: existing?.endOffset ?? at,
        text: `${existing ? "" : " "}data-hf-cutroom-clip-id="${value}"`,
      });
    });
    return edits
      .sort((a, b) => b.at - a.at)
      .reduce(
        (html, edit) =>
          html.slice(0, edit.at) + edit.text + html.slice(edit.end),
        html,
      );
  };
  const marked = mark(source, (node) =>
    locations.get(node.sourceCodeLocation?.startOffset ?? -1),
  );
  if (source === html) return marked;
  const identities = new Map<string, (string | undefined)[]>();
  visit(parse(ensureHfIds(marked)).childNodes, (node) => {
    const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
    const id = attrs.get("data-hf-cutroom-clip-id");
    const hfId = attrs.get("data-hf-id");
    if (hfId) {
      const matches = identities.get(hfId) ?? [];
      matches.push(id);
      identities.set(hfId, matches);
    }
  });
  return mark(ensureHfIds(html), (node) =>
    identities
      .get(node.attrs.find(({ name }) => name === "data-hf-id")?.value ?? "")
      ?.shift(),
  );
}

export function previewDocument(
  html: string,
  composition = "index.html",
  dependencies = "",
) {
  if (!html.includes("data-hf-cutroom-clip-id="))
    html = withPreviewClipIdentities(html);
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find((node) => node.nodeName === "html");
  const head =
    root && "childNodes" in root
      ? root.childNodes.find((node) => node.nodeName === "head")
      : undefined;
  const location = head && "tagName" in head ? head.sourceCodeLocation : null;
  const offset = location?.startTag?.endOffset ?? html.length;
  const sourceTexts: [string, string[]][] = [];
  const { sources, edits } = compositionScriptSources(document, composition);
  // The opaque frame needs CORS media for Web Audio, including gain above unity and its level tap.
  // Only the served preview changes; project source and its producer input stay untouched.
  const visit = (nodes: DefaultTreeAdapterTypes.ChildNode[], fps = 30) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      const rate = node.attrs.find(({ name }) => name === "data-fps");
      const parsed = rate && parseFpsWithDefault(rate.value);
      const nodeFps = parsed?.ok ? parsed.value.num / parsed.value.den : fps;
      // The runtime snaps visibility to frames, but seeks media using raw seconds.
      // Align those windows in served documents so rounded edit times cannot show
      // a piece that the seek still considers to be in the future.
      const timing = new Map(
        node.attrs.map(({ name, value }) => [name, value]),
      );
      const id = timing.get("data-hf-cutroom-clip-id");
      if (id && timing.has("data-start")) {
        const text = node.childNodes
          .map((child) =>
            "value" in child
              ? child.value
              : "tagName" in child && child.tagName === "br"
                ? "\n"
                : "",
          )
          .join("");
        sourceTexts.push([
          id,
          [
            canonicalText(text),
            canonicalText(
              node.childNodes
                .map((child) =>
                  "value" in child
                    ? child.value.replace(/[\t\n\f\r ]+/g, " ")
                    : "tagName" in child && child.tagName === "br"
                      ? "\n"
                      : "",
                )
                .join(""),
            ),
          ],
        ]);
      }
      const start = Number(timing.get("data-start"));
      const duration = Number(timing.get("data-duration"));
      const end = timing.has("data-duration")
        ? start + duration
        : Number(timing.get("data-end"));
      if (Number.isFinite(start)) {
        const window = exportClipWindow(start, end, nodeFps);
        for (const [name, value] of [
          ["data-start", window.start],
          ["data-duration", window.end - window.start],
          ["data-end", window.end],
        ] as const) {
          const location = node.sourceCodeLocation?.attrs?.[name];
          if (
            location &&
            Number.isFinite(value) &&
            (window.start !== start || window.end !== end) &&
            Number(timing.get(name)) !== value
          )
            edits.push({
              offset: location.startOffset,
              end: location.endOffset,
              text: `${name}="${value}"`,
            });
        }
      }
      if (
        (node.tagName === "audio" || node.tagName === "video") &&
        !node.attrs.some(({ name }) => name === "crossorigin")
      ) {
        const start = node.sourceCodeLocation?.startTag?.startOffset;
        if (start !== undefined)
          edits.push({
            offset: start + node.tagName.length + 1,
            end: start + node.tagName.length + 1,
            text: ' crossorigin="anonymous"',
          });
      }
      visit(node.childNodes, nodeFps);
      if ("content" in node) visit(node.content.childNodes, nodeFps);
    }
  };
  visit(document.childNodes);
  const normalized = edits
    .sort((a, b) => b.offset - a.offset)
    .reduce(
      (source, edit) =>
        source.slice(0, edit.offset) + edit.text + source.slice(edit.end),
      html,
    );
  const timing = previewTiming(normalized, dependencies);
  // Escape '<' so authored words cannot terminate the bridge's script element.
  const args = JSON.stringify([
    sourceTexts,
    { ...timing, clips: timing.clips.map(({ id }) => ({ id })) },
  ]).replaceAll("<", "\\u003c");
  const bridge = `${compositionDiagnosticsScript(composition, sources)}<script>(${installPreviewBridge.toString()})(...${args});</script>`;
  // All normalization edits are in the body or attributes after the head's opening tag.
  const insertion = location?.startTag ? offset : normalized.length;
  return {
    html: normalized.slice(0, insertion) + bridge + normalized.slice(insertion),
    timing,
  };
}

export function withPreviewBridge(html: string, composition = "index.html") {
  return previewDocument(html, composition).html;
}
