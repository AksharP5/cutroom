# Architecture

Cutroom has one local server and a React workspace. The Electron application is a contained desktop host for that same interface. Startup and shutdown share one lifetime, including a backend that has not finished opening. Linux installation stores immutable app versions under the user data directory and switches a launcher symlink after the copy completes. Project data stays outside those app folders.

## Project ownership

Projects remain ordinary HyperFrames folders. The application registry records their paths, while `cutroom.json` stores annotations and original word-timed transcripts. Source media is never rewritten by script cuts.

`src/server/projects/store.ts` owns the project registry, serialized Cutroom mutations, and one upstream `ProjectHistory` per folder. The native editor, transcript service, and MCP tools use that same history. Source writes require the exact content version they read. Metadata writes also refuse concurrent replacement. Shutdown rejects new edits and drains admitted mutations before closing history. The notebook reads compact annotations and a transcript revision; full words load when Script is opened.

External changes are watched and sent to the editor through server-sent events. The editor preserves its own file-write receipts, selection, playhead, and conflict handling.

## Editor integration

The public `@hyperframes/studio` application supplies the timeline, canvas editing, preview, inspector, and source editor. Cutroom supplies the surrounding workspace, review tools, agent panel, and original visual theme.

The shell is a fixed, dark-only layout: Media above one work panel on the left, the editor beside them, and a status bar below. Agent, Review, and Script share the work panel. Their components stay mounted while switching tabs so drafts and native sessions survive navigation. Transcript reads run only while Script is visible. Colours, type, and spacing are tokens in `src/client/styles.css`; the same tokens theme the embedded editor.

Shell controls read and write `src/client/workspace.ts`, a Cutroom-owned store for editor panel visibility and export state. `CutroomEditor` is the only code that mirrors it onto the upstream dock, so the shell does not depend on the embedded editor's layout internals.

`build/studioPlugin.ts` applies explicit, version-checked changes to the published source. It replaces branded chrome, removes hosted catalog and feedback, disables telemetry, and connects agent handoffs. The source package remains an upstream dependency rather than a copied editor fork.

Keep the HyperFrames packages on the same version. An upgrade must review each source transform, run the editing and preview/export tests, and inspect the workspace in a real browser. A successful build alone is insufficient.

For an upstream upgrade, update all `@hyperframes/*` dependencies and the `hyperframes` CLI together, then update `SUPPORTED_VERSION` in the build plugin. Source transforms fail when an expected upstream section changes. Review that change, adjust the integration, and run `bun run check`, `bun test`, and `bun run test:e2e` before packaging. Public editor improvements then come through the dependency. Features exclusive to the proprietary desktop application require independent implementation.

## Native agents

Codex runs through its app-server protocol. Claude Code runs through the Agent SDK with the installed executable and native Claude Code prompt. The adapters preserve the user's home, project directory, configuration, skill discovery, MCP connections, and recorded native session IDs.

The application persists conversation presentation separately from the provider's session. Streaming deltas do not rewrite history on every token. Approvals and questions are explicit pending requests; stale answers are refused. Model changes retain the native session and conversation. A single operation owns each pending or running turn and model change. Stop also cancels preparation, and callbacks from replaced runtimes cannot alter a newer run.

## Rendering and transcription

Preview and export use the public HyperFrames compiler and renderer. Export runs in an isolated Node worker because the producer's Node HTTP adapter modifies globals that Bun's server also uses. Keep `renderWorker.ts` beside `jobs.ts` when packaging. Cancellation waits for the owned process group and partial-output cleanup before shutdown completes.

Local transcription uses an already installed Whisper runtime and complete model. It runs outside the project in a temporary working folder, then imports normalized words through a history transaction. Job cancellation and shutdown await cleanup before closing project histories.

## External agents

Both MCP transports forward to the running server. They do not open a second project store or write files independently. The server binds to loopback and rejects foreign browser origins and rebinding hostnames. This endpoint is intended for agents on the same machine, not public network exposure.
