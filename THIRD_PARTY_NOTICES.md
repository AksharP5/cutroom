# Third-party notices

Cutroom's original code is MIT-licensed. Dependencies retain their own licenses; this file does not relicense them.

## HyperFrames

The public `@hyperframes/*` packages and `hyperframes` CLI are pinned to version 0.9.26 from [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes). The public framework is Apache-2.0 licensed; its license is preserved in [licenses/HYPERFRAMES.txt](licenses/HYPERFRAMES.txt).

`build/studioPlugin.ts` adapts the published editor source at build time. The adaptations replace the header, splash, transport icons, and agent handoff; remove hosted catalog and feedback UI; disable telemetry; connect external file changes to Cutroom; and preserve source synchronization, save conflicts, and project navigation. Every transform checks its source match and package version. Capture and rendering adapters build on the public Studio server and CLI implementations.

Cutroom does not include code or assets extracted from the proprietary HyperFrames desktop application. HyperFrames and HeyGen names describe dependency provenance, not affiliation or endorsement.

Cutroom also applies version-checked loading transforms to HyperFrames producer 0.9.26 in `src/server/hyperframes/renderIsolation.ts`. Browser discovery excludes media under `data-hidden`, preserving static parsing's visibility and audio exclusions. Entry and sub-composition compilation accept effective source supplied by Cutroom's render worker, so persisted track mixing also covers outside HTML edits without rewriting project files. Dependency files remain unchanged.

The Bun preload in `src/server/projects/historyView.ts` applies checked loading transforms to Studio Server 0.9.26. It excludes project view preferences from content snapshots and preserves the current view during undo, redo and restore. Dependency files remain unchanged.

## GSAP

GSAP 3.15.0 retains its [Standard No Charge License](https://gsap.com/community/standard-license/), including restrictions on competing visual animation builders. Cutroom's scope is local video composition and export. The licensor's FAQ permits AI-generated GSAP code and niche visual tools that do not directly compete with Webflow. Reassess that license before adding website-building capabilities or changing the product's scope. GSAP is not covered by Cutroom's MIT license.

## Native agents

Codex and Claude Code are installed and authenticated by the user. Cutroom does not modify their binaries, proxy their billing, or redistribute user credentials.

`@anthropic-ai/claude-agent-sdk` retains Anthropic's [applicable terms](https://code.claude.com/docs/en/legal-and-compliance). Its package notice is preserved in [licenses/ANTHROPIC-AGENT-SDK.txt](licenses/ANTHROPIC-AGENT-SDK.txt). The SDK drives the user's unmodified installed Claude Code executable.

## Interface assets

Instrument Sans and Martian Mono are vendored in `src/client/fonts/` as variable WOFF2 files and distributed under the SIL Open Font License 1.1. Their notices are preserved in [licenses/INSTRUMENT-SANS.txt](licenses/INSTRUMENT-SANS.txt) and [licenses/MARTIAN-MONO.txt](licenses/MARTIAN-MONO.txt). IBM Plex Sans is also distributed under the SIL Open Font License 1.1; its notice is preserved in [licenses/IBM-PLEX-SANS.txt](licenses/IBM-PLEX-SANS.txt). New projects receive the Instrument Sans font file and its license so compositions remain self-contained.

The Cutroom logo, mark, favicons, and application icon are original Cutroom assets.

Phosphor icons retain the MIT license of `@phosphor-icons/react`. React, Hono, Zustand, Vite, and other dependencies retain the license files in their installed packages.

Lightning CSS 1.33.0 parses and rewrites the inspector's inline opacity styles. Its MPL-2.0 license is retained in `node_modules/lightningcss/LICENSE`, including in the production package. The dependency source is unchanged.

## Packaged runtimes

Electron's distribution retains `LICENSE` and `LICENSES.chromium.html`. Packaged Node.js retains its runtime license, including bundled third-party notices. Bun's license and runtime dependency information are preserved in [licenses/BUN.txt](licenses/BUN.txt); corresponding source is available at [oven-sh/bun, tag bun-v1.4.4](https://github.com/oven-sh/bun/tree/bun-v1.4.4).

FFmpeg and a Chromium-compatible browser are external prerequisites. Local transcription uses an independently installed Whisper runtime and model. Those tools and media files retain their own licenses.
