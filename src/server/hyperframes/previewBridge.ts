import { parse } from "parse5";

interface PreviewWindow extends Window {
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
        case "play":
          win.__player?.play();
          break;
        case "pause":
          win.__player?.pause();
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
  return `${html.slice(0, offset)}<script>${previewBridgeScript}</script>${html.slice(offset)}`;
}
