import type { CompositionDiagnostic } from "../../shared/preview";

export interface DiagnosticWindow extends Window {
  __hfStartupError?: unknown;
  __hfScriptState?: (state: string, file: string) => void;
  __cutroomReadDiagnostics?: () => CompositionDiagnostic[];
}

/** Installed before authored scripts, including the compiler's caught setup failures. */
function installDiagnostics(entryFile: string) {
  const win = window as DiagnosticWindow;
  const errors: CompositionDiagnostic[] = [];
  const seen = new Set<string>();
  let currentFile: string | undefined;
  let startupError: unknown;
  const fileName = (url: string) => {
    const path = url.split("/preview/")[1];
    return path ? decodeURIComponent(path.split(/[?#]/)[0]!) : entryFile;
  };
  const compositionFile = (id: string | null) =>
    id
      ? document
          .querySelector(`[data-composition-id="${CSS.escape(id)}"]`)
          ?.getAttribute("data-composition-file")
      : null;
  const report = (file: string, reason: unknown) => {
    const message =
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : String(reason);
    const key = JSON.stringify([file, message]);
    if (seen.has(key) || errors.length >= 20) return;
    seen.add(key);
    errors.push({ file, message });
    parent.postMessage(
      {
        source: "cutroom-preview",
        type: "composition-errors",
        diagnostics: [...errors],
      },
      "*",
    );
  };
  const scriptState = win.__hfScriptState;
  win.__hfScriptState = (state, file) => {
    currentFile = state === "start" ? file : undefined;
    scriptState?.(state, file);
  };
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (
      args[0] === "[HyperFrames] composition script error:" ||
      args[0] === "[hyperframes] scene timeline callback threw:"
    ) {
      const id = typeof args[1] === "string" ? args[1] : null;
      report(currentFile ?? compositionFile(id) ?? entryFile, args.at(-1));
    }
    consoleError(...args);
  };
  window.addEventListener(
    "error",
    (event: Event) => {
      if (event instanceof ErrorEvent)
        report(
          currentFile ??
            compositionFile(
              document.currentScript?.getAttribute("data-hf-scene") ?? null,
            ) ??
            fileName(event.filename),
          event.error ?? event.message,
        );
      else if (event.target instanceof HTMLScriptElement)
        report(fileName(event.target.src), "Script could not be loaded.");
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) =>
    report(currentFile ?? entryFile, event.reason),
  );
  win.__cutroomReadDiagnostics = () => {
    if (win.__hfStartupError && win.__hfStartupError !== startupError) {
      startupError = win.__hfStartupError;
      const message = String(startupError);
      const host = [
        ...document.querySelectorAll("[data-composition-file]"),
      ].find((host) =>
        message.startsWith(
          `window.__hf.buildReady[${JSON.stringify(host.getAttribute("data-composition-id"))}] rejected:`,
        ),
      );
      report(
        host?.getAttribute("data-composition-file") ?? entryFile,
        startupError,
      );
    }
    return errors;
  };
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      // The bundler removes data-composition-src only after successfully inlining a scene.
      for (const host of document.querySelectorAll("[data-composition-src]"))
        report(
          host.getAttribute("data-composition-src")!,
          "Sub-composition could not be loaded.",
        );
      win.__cutroomReadDiagnostics?.();
    },
    { once: true },
  );
}

export function compositionDiagnosticsScript(entryFile: string) {
  return `<script>(${installDiagnostics.toString()})(${JSON.stringify(entryFile).replaceAll("<", "\\u003c")});</script>`;
}
