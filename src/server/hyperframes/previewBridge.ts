import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { exportClipWindow, parseFpsWithDefault } from "@hyperframes/core";

interface PreviewWindow extends Window {
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
  __hfStartupError?: unknown;
}

/** Runs inside the opaque preview. The only commands affect its own picture and playback. */
function installPreviewBridge() {
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
    const element = document.querySelector(`#${CSS.escape(draft.clipId)}`);
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
    clearTimeout(observationTimer);
    if (observedClip)
      observationTimer = window.setTimeout(scheduleObservation, 350);
  };
  let observedClip: string | null = null;
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
      const element = document.querySelector(`#${CSS.escape(observedClip)}`);
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
          // A newer seek owns the displayed picture. Check only after it settles.
          if (version !== pictureVersion) {
            scheduleObservation();
            return;
          }
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
    if (!observedClip || !observingPosition || !win.__player?.isPlaying())
      return;
    observationTimer = window.setTimeout(() => {
      scheduleObservation();
    }, 350);
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
      error: win.__hfStartupError ? String(win.__hfStartupError) : null,
      width: size("data-width", 1920),
      height: size("data-height", 1080),
      fps: root?.getAttribute("data-fps") ?? null,
      time: Number(win.__player?.getTime() ?? 0),
      playing: Boolean(win.__player?.isPlaying()),
    };
  };
  const reply = (id?: string, error?: string) =>
    parent.postMessage(
      { source: "cutroom-preview", id, state: state(), error },
      "*",
    );
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
    pictureVersion += 1;
    clearTimeout(observationTimer);
    cancelAnimationFrame(observationFrame);
    observationFrame = 0;
    // The parent compositor can still show this document while retiring its iframe.
    // Release decoding resources without erasing the last painted picture.
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
          observedClip = data.clipId;
          scheduleObservation();
          break;
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
        case "inspect":
          break;
        case "meter":
          if (!("enabled" in data) || typeof data.enabled !== "boolean") return;
          metering = data.enabled;
          cancelAnimationFrame(animation);
          animation = 0;
          if (metering) levels();
          else win.__hf?.audioMeter?.stop();
          break;
        case "play":
          pictureVersion += 1;
          for (const video of holds.keys()) releasePlaying(video);
          win.__player?.play();
          observePlaying();
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
          break;
        case "seek":
          if (
            !("time" in data) ||
            typeof data.time !== "number" ||
            !Number.isFinite(data.time) ||
            data.time < 0
          )
            return;
          win.__player?.seek(data.time);
          if (!win.__player?.isPlaying()) await refreshPicture();
          scheduleObservation();
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

export const previewBridgeScript = `(${installPreviewBridge.toString()})();`;

export function withPreviewBridge(html: string) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find((node) => node.nodeName === "html");
  const head =
    root && "childNodes" in root
      ? root.childNodes.find((node) => node.nodeName === "head")
      : undefined;
  const location = head && "tagName" in head ? head.sourceCodeLocation : null;
  const offset = location?.startTag?.endOffset ?? html.length;
  const edits = [
    { offset, end: offset, text: `<script>${previewBridgeScript}</script>` },
  ];
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
  return edits
    .sort((a, b) => b.offset - a.offset)
    .reduce(
      (source, edit) =>
        source.slice(0, edit.offset) + edit.text + source.slice(edit.end),
      html,
    );
}
