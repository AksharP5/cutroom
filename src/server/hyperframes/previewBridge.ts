import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { exportClipWindow, parseFpsWithDefault } from "@hyperframes/core";

interface PreviewWindow extends Window {
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
      // Split computed translate only at top-level spaces, preserving calc() and a third axis.
      const parts: string[] = [];
      let depth = 0;
      let part = "";
      for (const char of original.base === "none" ? "" : original.base) {
        if (char === "(") depth++;
        if (char === ")") depth--;
        if (/\s/.test(char) && depth === 0) {
          if (part) parts.push(part);
          part = "";
        } else part += char;
      }
      if (part) parts.push(part);
      translate = `calc(${parts[0] ?? "0px"} + ${draft.x - original.x}px) calc(${parts[1] ?? "0px"} + ${draft.y - original.y}px)${parts[2] ? ` ${parts[2]}` : ""}`;
    }
    // The parked video is represented by its held canvas. Both share the same style.
    element.style.setProperty("translate", translate, original.priority);
    if (element instanceof HTMLVideoElement)
      holds
        .get(element)
        ?.canvas.style.setProperty("translate", translate, original.priority);
    if (draft.x === null) positions.delete(element);
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
      display: string;
      callback?: number;
      timer?: number;
    }
  >();
  const FRAME_TIMEOUT = 8_000;
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
    holds.get(video)?.canvas.remove();
    holds.delete(video);
    video.removeAttribute("data-cutroom-held");
    video.removeAttribute("data-cutroom-flow");
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
            for (const [video, hold] of holds) {
              hold.canvas.style.setProperty("display", "none", "important");
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
            for (const [video, hold] of holds) {
              video.setAttribute("data-cutroom-held", "");
              hold.canvas.style.setProperty("display", hold.display);
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
            for (const [video] of holds) {
              if (!videos.includes(video)) removeHold(video);
            }
            for (const video of videos) {
              cancelRelease(video);
              const previous = holds.get(video);
              previous?.canvas.style.setProperty(
                "display",
                "none",
                "important",
              );
              video.removeAttribute("data-cutroom-held");
              try {
                const style = getComputedStyle(video);
                const canvas = document.createElement("canvas");
                canvas.setAttribute("data-cutroom-video-hold", "");
                for (const name of style)
                  canvas.style.setProperty(name, style.getPropertyValue(name));
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
                canvas.width =
                  style.objectFit === "none"
                    ? video.videoWidth
                    : unitWidth * scale;
                canvas.height =
                  style.objectFit === "none"
                    ? video.videoHeight
                    : unitHeight * scale;
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
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                video.after(canvas);
                holds.get(video)?.canvas.remove();
                holds.set(video, { canvas, display: canvas.style.display });
              } finally {
                const hold = holds.get(video);
                if (hold) {
                  video.setAttribute("data-cutroom-held", "");
                  hold.canvas.style.setProperty("display", hold.display);
                }
              }
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
      if (event.target instanceof HTMLVideoElement)
        releasePlaying(event.target);
    },
    true,
  );
  addEventListener("pagehide", () => {
    pictureVersion += 1;
    for (const video of holds.keys()) removeHold(video);
  });
  addEventListener("message", (event: MessageEvent<unknown>) => {
    if (
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
          if (metering && !animation) levels();
          break;
        case "pause":
          win.__player?.pause();
          cancelAnimationFrame(animation);
          animation = 0;
          if (metering) levels();
          await refreshPicture();
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
