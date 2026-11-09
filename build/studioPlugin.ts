import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const SUPPORTED_VERSION = "0.9.26";

function replaceOnce(
  source: string,
  before: string,
  after: string,
  file: string,
): string {
  if (source.split(before).length !== 2) {
    throw new Error(
      `Cutroom's ${SUPPORTED_VERSION} editor integration no longer matches ${file}. Review the upstream change before upgrading.`,
    );
  }
  return source.replace(before, after);
}

/** The Apache-licensed editor remains upstream. These explicit host changes are checked on each build. */
export function studioPlugin(): Plugin {
  const packageRoot = resolve("node_modules/@hyperframes/studio");
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    manifest.version !== SUPPORTED_VERSION
  ) {
    throw new Error(
      `Cutroom requires @hyperframes/studio ${SUPPORTED_VERSION}; upgrade the integration deliberately.`,
    );
  }
  const header = JSON.stringify(resolve("src/client/editor/EditorHeader.tsx"));
  return {
    name: "cutroom-studio-host",
    enforce: "pre",
    resolveId(id) {
      if (id === "canvas")
        return resolve(packageRoot, "src/shims/canvasBrowserStub.js");
    },
    transform(source, rawId) {
      const id = rawId.split("?")[0]?.replaceAll("\\", "/");
      if (!id?.includes("/@hyperframes/studio/src/")) return;
      if (id.endsWith("/components/StudioHeader.tsx")) {
        if (!source.includes("export const StudioHeader"))
          throw new Error("Upstream StudioHeader changed.");
        return {
          code: `export { EditorHeader as StudioHeader } from ${header};`,
          map: null,
        };
      }
      if (id.endsWith("/components/StudioSplash.tsx")) {
        return {
          code: 'export function StudioSplash({waiting}) { return <div className="editor-loading" role="status">{waiting ? "Connecting to the local editor…" : "Opening composition…"}</div>; }',
          map: null,
        };
      }
      if (id.endsWith("/components/ui/HyperframesLoader.tsx")) {
        if (!source.includes("export function HyperframesLoader"))
          throw new Error("Upstream composition loader changed.");
        return {
          code: `export function HyperframesLoader({title,detail,mono,progress}) { return <div className="cutroom-loading-status" role="status"><span>{title}</span>{detail && <small>{detail}</small>}{typeof progress === "number" && <progress max={1} value={Math.max(0,Math.min(1,progress))} />}{mono && <small>{mono}</small>}</div>; } export function StatusFrame(props) { return <HyperframesLoader {...props} />; }`,
          map: null,
        };
      }
      if (id.endsWith("/components/StudioOverlays.tsx")) {
        let code = replaceOnce(
          source,
          'import { StudioFeedbackCard } from "./feedback/StudioFeedbackCard";\n',
          "",
          id,
        );
        code = replaceOnce(code, "        <StudioFeedbackCard />", "", id);
        return { code, map: null };
      }
      if (id.endsWith("/components/StudioLeftPanels.tsx")) {
        let code = replaceOnce(
          source,
          'import { BlocksTab, type BlockPreviewInfo } from "./sidebar/BlocksTab";',
          'import type { BlockPreviewInfo } from "./sidebar/BlocksTab";',
          id,
        );
        code = replaceOnce(
          code,
          `      <Dock.Panel id="catalog">
        <PanelColumn footer={lintButton}>
          <BlocksTab onAddBlock={onAddBlock} onPreviewBlock={onPreviewBlock} />
        </PanelColumn>
      </Dock.Panel>
`,
          "",
          id,
        );
        return { code, map: null };
      }
      if (id.endsWith("/components/dock/panelRegistry.ts")) {
        let code = replaceOnce(source, '  "catalog",\n', "", id);
        code = replaceOnce(
          code,
          `  catalog: {
    title: "Catalog",
    zone: "left",
    reopen: { near: "compositions", direction: "within" },
  },
`,
          "",
          id,
        );
        return { code, map: null };
      }
      if (id.endsWith("/components/dock/dockLayout.ts")) {
        const code = replaceOnce(
          source,
          'const DEFAULT_LEFT = ["compositions", "assets", "code", "catalog"] as const;',
          'const DEFAULT_LEFT = ["compositions", "assets", "code"] as const;',
          id,
        );
        return { code, map: null };
      }
      if (id.endsWith("/components/dock/DockTab.tsx")) {
        const code = replaceOnce(source, "  catalog: SquaresFour,\n", "", id);
        return { code, map: null };
      }
      if (id.endsWith("/player/components/PlayerControls.tsx")) {
        let code = replaceOnce(
          source,
          'import gsap from "gsap";\nimport { MorphSVGPlugin } from "gsap/MorphSVGPlugin";',
          'import { Play, Pause } from "@phosphor-icons/react";',
          id,
        );
        const startMarker = "gsap.registerPlugin(MorphSVGPlugin);";
        const endMarker =
          "/* ── Button sub-components ───────────────────────────────────────── */";
        const start = code.indexOf(startMarker);
        const end = code.indexOf(endMarker);
        if (
          start < 0 ||
          end <= start ||
          !code.slice(start, end).includes("const PLAY_BLADE_D")
        )
          throw new Error("Upstream transport glyph changed.");
        code =
          code.slice(0, start) +
          `function PlayPauseMorphIcon({ playing }: { playing: boolean }) {
  return playing ? <Pause size={15} weight="fill" aria-hidden /> : <Play size={15} weight="fill" aria-hidden />;
}

` +
          code.slice(end);
        return { code, map: null };
      }
      if (id.endsWith("/App.tsx")) {
        const code = replaceOnce(
          source,
          "                <StudioHeader\n",
          `                <StudioHeader
                  onUndo={appHotkeys.handleUndo}
                  onRedo={appHotkeys.handleRedo}
                  canUndo={historyFlags.canUndo}
                  canRedo={historyFlags.canRedo}
                  undoLabel={historyFlags.undoLabel}
                  redoLabel={historyFlags.redoLabel}
                  isRendering={renderQueue.isRendering}
                  ffmpegMissing={renderQueue.ffmpegMissing}
                  onInspector={() => {
                    panelLayout.setRightPanelTab("design");
                    panelLayout.setRightCollapsed(!inspectorButtonActive);
                  }}
`,
          id,
        );
        return { code, map: null };
      }
      if (id.endsWith("/hooks/useAskAgentModal.ts")) {
        const code = replaceOnce(
          source,
          "      const copied = await copyTextToClipboard(prompt);",
          `      window.dispatchEvent(new CustomEvent("cutroom:ask-agent", { detail: { prompt } }));
      const copied = true;`,
          id,
        );
        return { code, map: null };
      }
      if (id.endsWith("/hooks/useExternalFileChangeCoordinator.ts")) {
        let code = replaceOnce(
          source,
          "    if (import.meta.hot) {",
          "    if (false && import.meta.hot) {",
          id,
        );
        code = replaceOnce(
          code,
          "    return sseFileChangeChannel(handler, catchUp);",
          `    const close = sseFileChangeChannel(handler, catchUp);
    window.addEventListener("cutroom:refresh-editor", catchUp);
    return () => {
      window.removeEventListener("cutroom:refresh-editor", catchUp);
      close();
    };`,
          id,
        );
        return { code, map: null };
      }
      if (id.endsWith("/telemetry/policy.ts")) {
        const start = source.indexOf(
          "export function browserTelemetryAllowed(): boolean {",
        );
        const end = source.indexOf("\ndeclare global", start);
        if (start < 0 || end < start)
          throw new Error("Upstream telemetry policy changed.");
        return {
          code:
            source.slice(0, start) +
            "export function browserTelemetryAllowed(): boolean { return false; }\n" +
            source.slice(end),
          map: null,
        };
      }
    },
  };
}
