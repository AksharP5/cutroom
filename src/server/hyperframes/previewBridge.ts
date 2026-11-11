import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { exportClipWindow, parseFpsWithDefault } from "@hyperframes/core";

interface PreviewWindow extends Window {
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
  let metering = false;
  let animation = 0;
  const levels = () => {
    if (!metering) return;
    const meter = win.__hf?.audioMeter;
    meter?.start();
    const level = win.__player?.isPlaying() ? meter?.read().master : null;
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
          win.__player?.play();
          if (metering && !animation) levels();
          break;
        case "pause":
          win.__player?.pause();
          cancelAnimationFrame(animation);
          animation = 0;
          if (metering) levels();
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
          if (typeof win.__hfWaitForSeekCompletion !== "function")
            throw new Error(
              "The preview cannot confirm that it drew the frame.",
            );
          await win.__hfWaitForSeekCompletion();
          // Seek completion can omit an unprepared video. Keep the live iframe until
          // every visible native video has a decoded frame, including a new split piece.
          for (;;) {
            const videos = Array.from(
              document.querySelectorAll("video"),
            ).filter((video) =>
              video.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              }),
            );
            const failed = videos.find((video) => video.error);
            if (failed)
              throw new Error(
                `The preview could not load ${failed.getAttribute("src")}.`,
              );
            if (
              videos.every((video) => video.readyState >= 2 && !video.seeking)
            )
              break;
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
          }
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
