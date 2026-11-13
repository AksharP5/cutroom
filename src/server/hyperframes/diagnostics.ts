import type { DefaultTreeAdapterTypes } from "parse5";
import type { CompositionDiagnostic } from "../../shared/preview";

export interface DiagnosticWindow extends Window {
  __hfStartupError?: unknown;
  __hfScriptState?: (state: string, file: string) => void;
  __cutroomReadDiagnostics?: () => CompositionDiagnostic[];
}

type ScriptSource = [url: string, file: string];

/** Keep browser stack locations tied to the source file after setup has finished. */
export function compositionScriptSources(
  document: DefaultTreeAdapterTypes.Document,
  entryFile: string,
) {
  const files = new Map<string, string>();
  const scripts: DefaultTreeAdapterTypes.Element[] = [];
  let root = true;
  const visit = (nodes: DefaultTreeAdapterTypes.ChildNode[]) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
      const id = attrs.get("data-composition-id");
      if (id) {
        const file =
          attrs.get("data-composition-file") ?? (root ? entryFile : undefined);
        if (file) files.set(id, file);
        root = false;
      }
      if (node.tagName === "script") scripts.push(node);
      visit(node.childNodes);
      if ("content" in node) visit(node.content.childNodes);
    }
  };
  visit(document.childNodes);
  const sources: ScriptSource[] = [];
  const edits: { offset: number; end: number; text: string }[] = [];
  const executable = new Set([
    "",
    "text/javascript",
    "application/javascript",
    "text/ecmascript",
    "application/ecmascript",
    "module",
    "text/hf-after-fonts",
    "text/hf-after-fonts+module",
  ]);
  for (const script of scripts) {
    const attrs = new Map(script.attrs.map(({ name, value }) => [name, value]));
    const location = script.sourceCodeLocation;
    if (
      !location?.startTag ||
      !location.endTag ||
      attrs.has("src") ||
      attrs.has("data-hyperframes-preview-runtime") ||
      attrs.has("data-hf-after-fonts-fallback") ||
      !executable.has((attrs.get("type") ?? "").trim().toLowerCase())
    )
      continue;
    const scene = attrs.get("data-hf-scene");
    let file =
      attrs.get("data-hf-inlined-src") ??
      (scene ? files.get(scene) : entryFile);
    const content = script.childNodes
      .map((node) => ("value" in node ? node.value : ""))
      .join("");
    // HyperFrames 0.9.26 puts module identity in its prelude rather than data-hf-scene.
    if (
      !scene &&
      content.startsWith(
        "const __hyperframes = (function(__hfBaseHyperframes, __hfTimelineCompId, __hfCompositionSrc) {",
      )
    ) {
      const identity =
        /\}\)\(window\.__hyperframes,\s*("(?:\\.|[^"\\])*"),/.exec(
          content,
        )?.[1];
      const id: unknown = identity ? JSON.parse(identity) : undefined;
      file = typeof id === "string" ? files.get(id) : undefined;
    }
    if (!file) continue;
    const encoded = encodeURIComponent(file)
      .replaceAll("(", "%28")
      .replaceAll(")", "%29");
    const url = `cutroom-source:///${sources.length}/${encoded}`;
    sources.push([url, file]);
    edits.push({
      offset: location.startTag.endOffset - 1,
      end: location.startTag.endOffset - 1,
      text: ` data-cutroom-source="${url}"`,
    });
    edits.push({
      offset: location.endTag.startOffset,
      end: location.endTag.startOffset,
      text: `\n//# sourceURL=${url}\n`,
    });
  }
  return { sources, edits };
}

/** Installed before authored scripts, including the compiler's caught setup failures. */
function installDiagnostics(entryFile: string, sources: ScriptSource[]) {
  const sourceFiles = new Map(sources);
  const win = window as DiagnosticWindow;
  const errors: CompositionDiagnostic[] = [];
  const seen = new Set<string>();
  let currentFile: string | undefined;
  let startupError: unknown;
  const fileName = (url: string) => {
    const known = sourceFiles.get(url);
    if (known) return known;
    if (url === document.URL) return;
    const path = url.split("/preview/")[1];
    if (!path) return;
    try {
      return decodeURIComponent(path.split(/[?#]/)[0]!);
    } catch {
      return;
    }
  };
  const stackFile = (reason: unknown) => {
    const stack =
      typeof reason === "string"
        ? reason
        : reason && typeof reason === "object" && "stack" in reason
          ? reason.stack
          : undefined;
    if (typeof stack !== "string") return;
    for (const [location] of stack.matchAll(
      /(?:cutroom-source|https?):\/\/[^\s)]+/g,
    )) {
      const file = fileName(location.replace(/:\d+(?::\d+)?$/, ""));
      if (file) return file;
    }
  };
  const currentScriptFile = () =>
    sourceFiles.get(
      document.currentScript?.getAttribute("data-cutroom-source") ?? "",
    );
  const compositionFile = (id: string | null) => {
    const host = id
      ? document.querySelector(`[data-composition-id="${CSS.escape(id)}"]`)
      : null;
    return (
      host?.getAttribute("data-composition-file") ??
      (host && host === document.querySelector("[data-composition-id]")
        ? entryFile
        : undefined)
    );
  };
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
      report(
        stackFile(args.at(-1)) ??
          compositionFile(id) ??
          currentScriptFile() ??
          currentFile ??
          "unknown file",
        args.at(-1),
      );
    }
    consoleError(...args);
  };
  window.addEventListener(
    "error",
    (event: Event) => {
      if (event instanceof ErrorEvent)
        report(
          stackFile(event.error) ??
            fileName(event.filename) ??
            currentScriptFile() ??
            currentFile ??
            "unknown file",
          event.error ?? event.message,
        );
      else if (event.target instanceof HTMLScriptElement)
        report(
          fileName(event.target.src) ?? "unknown file",
          "Script could not be loaded.",
        );
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) =>
    report(
      stackFile(event.reason) ??
        currentScriptFile() ??
        currentFile ??
        "unknown file",
      event.reason,
    ),
  );
  win.__cutroomReadDiagnostics = () => {
    if (win.__hfStartupError && win.__hfStartupError !== startupError) {
      startupError = win.__hfStartupError;
      const message = String(startupError);
      const host = [...document.querySelectorAll("[data-composition-id]")].find(
        (host) =>
          message.startsWith(
            `window.__hf.buildReady[${JSON.stringify(host.getAttribute("data-composition-id"))}] rejected:`,
          ),
      );
      report(
        stackFile(startupError) ??
          compositionFile(host?.getAttribute("data-composition-id") ?? null) ??
          "unknown file",
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

export function compositionDiagnosticsScript(
  entryFile: string,
  sources: ScriptSource[],
) {
  const input = JSON.stringify([entryFile, sources]).replaceAll("<", "\\u003c");
  return `<script>(${installDiagnostics.toString()})(...${input});</script>`;
}
