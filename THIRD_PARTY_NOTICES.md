# Third-party notices

Cutroom's original code is MIT-licensed. Dependencies retain their own licenses; this file does not relicense them.

## HyperFrames

The public `@hyperframes/*` packages and `hyperframes` CLI are pinned to version 0.9.26 from [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes). The public framework is Apache-2.0 licensed; its license is preserved in [licenses/HYPERFRAMES.txt](licenses/HYPERFRAMES.txt).

`build/studioPlugin.ts` adapts the published editor source at build time. The adaptations replace the header, splash, transport icons, and agent handoff; remove hosted catalog and feedback UI; disable telemetry; connect external file changes to Cutroom; and preserve source synchronization, save conflicts, and project navigation. Every transform checks its source match and package version. Capture and rendering adapters build on the public Studio server and CLI implementations.

Cutroom does not include code or assets extracted from the proprietary HyperFrames desktop application. HyperFrames and HeyGen names describe dependency provenance, not affiliation or endorsement.

The authored Motion inspector uses the public `parseGsapScript`, `parseGsapScriptAcornForWrite` and `updateAnimationInScript` APIs from `@hyperframes/parsers` 0.9.26 on the server. Cutroom supplies its own inspector and literal-edit boundary; no Studio interface was copied. Only the requested literal from the writer's output is applied, preserving the surrounding source.

Freeze frame follows the two-second hold in public `@hyperframes/studio-server` 0.9.26. Cutroom extracts the picture on its preview frame grid and uses its timeline commands and project history to write the edit. The history engine gives Cutroom the recorded history before replay so it can protect referenced stills. It rolls back earlier file writes when replay fails partway through.

Cutroom includes modified copies of the [HyperFrames v0.9.26 history engine source](https://github.com/heygen-com/hyperframes/tree/v0.9.26/packages/studio-server/src/history) in `src/server/history/` under [Apache-2.0](licenses/HYPERFRAMES.txt), copyright 2026 HeyGen, Inc. The attributed tests and log fixture in `tests/history/` come from the same release. Cutroom adjusted imports, moved its replay validation and rollback patch into TypeScript, retained the history-writing portion of `videoState.ts`, and adapted the tests for Bun. Studio owns its routes, file mutation helpers, project signature, safe paths, write receipts, and active preview file streams. An export-only Bun patch exposes the shared helpers to Cutroom's engine without creating separate registries.

The Library's categories in `src/server/library/registry.ts` follow `resolveBlockCategory` from HyperFrames v0.9.26 `packages/core/src/registry/types.ts` (Apache-2.0), which the package does not export; Cutroom adds titles and lower thirds. Library items themselves are downloaded from the HyperFrames registry when an owner or agent adds one, and keep the license their registry entry states, or the registry repository's Apache-2.0 when they state none, recorded in the project's `cutroom.json`. Cutroom copies GSAP's own plugins from its pinned `gsap` package into a project when an added item uses them.

Cutroom also applies version-checked loading transforms to HyperFrames producer 0.9.26 in `src/server/hyperframes/renderIsolation.ts`. Browser discovery excludes media under `data-hidden`, preserving static parsing's visibility and audio exclusions. Entry and sub-composition compilation accept effective source supplied by Cutroom's render worker, so persisted track mixing also covers outside HTML edits without rewriting project files. The same compilation hooks select a freeze frame's export PNG when preview and export use different SDR colour conversions. Dependency files remain unchanged.

The render isolation also uses Cutroom's source picture ordinals in the HyperFrames extraction and frame lookup stages. It reuses the published FFmpeg extraction limits, image encode settings and colour filters. A marked render carries its picture slots through the producer's local render plan.

The same transforms let `renderSpan` render MOV and WebM ranges with the producer's own chunk encoders. `src/server/hyperframes/gif.ts` follows the producer's GIF encode stage (`palettegen`/`paletteuse` settings and its frame-clearing pass through `@hyperframes/core`), building the palette from every pixel instead of changed pixels.

The same file applies one version-checked loading transform to Apache-2.0 `@puppeteer/browsers` 3.2.2 in the render worker: browsers stay in the worker's process group instead of starting their own sessions, so stopping an export also stops its browsers. Dependency files remain unchanged.

`src/server/hyperframes/previewRuntime.ts` adapts the served runtime in memory, with an exact source-match and version check for core 0.9.26. It refreshes a group's static gain when `data-volume` changes even when that group had no automation lane. This lets a live track fader update the existing Web Audio stage. It also holds an automation lane at its first point until playback reaches it, where the pinned runtime ramped from the playhead, so live preview plays the envelope export bakes. The published dependency and export runtime files remain unchanged.

Cutroom extends HyperFrames rate lanes with a signed clock offset so trims and splits keep the authored curve. The Bun core patch and the in-memory runtime adapter reuse HyperFrames' rate sampler and integration grid.

The pinned patches in `patches/` share mounted scene path resolution and nested mount identity between the public preview compiler and the Cutroom producer. The preview runtime adapter also makes fetched scenes use the compiler's template selection and default order.

## GSAP

GSAP 3.15.0 retains its [Standard No Charge License](https://gsap.com/community/standard-license/), including restrictions on competing visual animation builders. Cutroom's scope is local video composition and export. The licensor's FAQ permits AI-generated GSAP code and niche visual tools that do not directly compete with Webflow. Reassess that license before adding website-building capabilities or changing the product's scope. GSAP is not covered by Cutroom's MIT license. New projects copy the installed `dist/gsap.min.js` distribution, including its embedded copyright and license notice, into `assets/vendor/` for offline preview and export.

## Native agents

Codex and Claude Code are installed and authenticated by the user. Cutroom does not modify their binaries, proxy their billing, or redistribute user credentials.

`@anthropic-ai/claude-agent-sdk` retains Anthropic's [applicable terms](https://code.claude.com/docs/en/legal-and-compliance). Its package notice is preserved in [licenses/ANTHROPIC-AGENT-SDK.txt](licenses/ANTHROPIC-AGENT-SDK.txt). The SDK drives the user's unmodified installed Claude Code executable.

## Interface assets

Instrument Sans and Martian Mono are vendored in `src/client/fonts/` as variable WOFF2 files and distributed under the SIL Open Font License 1.1. Their notices are preserved in [licenses/INSTRUMENT-SANS.txt](licenses/INSTRUMENT-SANS.txt) and [licenses/MARTIAN-MONO.txt](licenses/MARTIAN-MONO.txt). IBM Plex Sans is also distributed under the SIL Open Font License 1.1; its notice is preserved in [licenses/IBM-PLEX-SANS.txt](licenses/IBM-PLEX-SANS.txt). Oswald, Fraunces and a full-range Martian Mono are vendored in `src/server/projects/fonts/` as variable WOFF2 files, converted losslessly with `woff2_compress` from the variable TrueType files in [google/fonts](https://github.com/google/fonts) (`ofl/oswald` at commit 8b0a1d0, `ofl/fraunces` at 4024282, `ofl/martianmono` at c8bba5c). They are distributed under the SIL Open Font License 1.1, and none of the three has a Reserved Font Name. Their notices are preserved in [licenses/OSWALD.txt](licenses/OSWALD.txt), [licenses/FRAUNCES.txt](licenses/FRAUNCES.txt) and [licenses/MARTIAN-MONO.txt](licenses/MARTIAN-MONO.txt). New projects receive Instrument Sans, Oswald, Fraunces and Martian Mono, each beside its license as `assets/fonts/<Name>-LICENSE.txt`, so compositions remain self-contained and titles can use them.

The Cutroom logo, mark, favicons, and application icon are original Cutroom assets.

Phosphor icons retain the MIT license of `@phosphor-icons/react`. React, Hono, Zustand, Vite, CodeMirror and Lezer (the code panel's editor, the same versions the embedded editor uses), and other dependencies retain the license files in their installed packages.

Lightning CSS 1.33.0 parses and rewrites the inspector's inline opacity styles. Its MPL-2.0 license is retained in `node_modules/lightningcss/LICENSE`, including in the production package. The dependency source is unchanged.

## Packaged runtimes

Electron's distribution retains `LICENSE` and `LICENSES.chromium.html`. Packaged Node.js retains its runtime license, including bundled third-party notices. Bun's license and runtime dependency information are preserved in [licenses/BUN.txt](licenses/BUN.txt); corresponding source is available at [oven-sh/bun, tag bun-v1.4.4](https://github.com/oven-sh/bun/tree/bun-v1.4.4).

FFmpeg and a Chromium-compatible browser are external prerequisites. Local transcription uses an independently installed Whisper runtime and model. Those tools and media files retain their own licenses.

Signalsmith Stretch is MIT-licensed. The render worker uses the Emscripten build from [Signalsmith Audio, commit 88061fd4](https://github.com/Signalsmith-Audio/signalsmith-stretch/tree/88061fd4eda56a2353c5d65c74aa3f4ccf76f9da/web/emscripten) to stretch local audio under authored speed ramps. The original SHA-256 is `f4af9d616062c67dbfe6a98d9bfd39f0149246f02c111122a10936f5c63d5cf6`. Cutroom adds an optional seed source to the generated JavaScript so each render of the same clip uses the same phase. The WASM payload is unchanged. The package preserves notices for [Signalsmith Stretch](licenses/SIGNALSMITH-STRETCH.txt), [Signalsmith Linear 0.6.6](licenses/SIGNALSMITH-LINEAR.txt), [Emscripten](licenses/EMSCRIPTEN.txt), and [musl](licenses/MUSL.txt).
