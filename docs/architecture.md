# Architecture

Cutroom has one local server and a React workspace. The Electron application is a contained desktop host for that same interface. Startup and shutdown share one lifetime, including a backend that has not finished opening. Linux installation stores immutable app versions under the user data directory and switches a launcher symlink after the copy completes. Project data stays outside those app folders.

## Project ownership

Projects remain ordinary HyperFrames folders. The application registry records their paths, while `cutroom.json` stores annotations and original word-timed transcripts. Review status lives in `.cutroom/review.json`, outside project history. `src/shared/review.ts` defines the one transition table that the UI routes, MCP tools, and agent turn lifecycle all pass through, and `src/server/projects/review.ts` runs every review change, plus the note deletes, edits, undo, redo, and restore that could race one, in a single queue per project. One reconcile step there derives status from the live notes and review.json and saves it, before every read and around every history change. Source media is never rewritten by script cuts.

`src/server/projects/store.ts` owns the project registry, serialized Cutroom mutations, and one upstream `ProjectHistory` per folder. The native editor, transcript service, and MCP tools use that same history. Source writes require the exact content version they read. Metadata writes also refuse concurrent replacement. Shutdown rejects new edits and drains admitted mutations before closing history. The notebook reads review items and a transcript revision; full words load when Script is opened.

External changes are watched and sent to the editor through server-sent events. The editor preserves its own file-write receipts, selection, playhead, and conflict handling.

Dot folders such as `.cutroom/` hold app state, including review captures and renders. They are left out of the project file list that Media, Assets, and the code tree read, and their changes do not refresh Media.

## Editor integration

The public `@hyperframes/studio` application supplies the timeline, canvas editing, preview, inspector, and source editor. Cutroom supplies the surrounding workspace, review tools, agent panel, and original visual theme.

The shell is a fixed, dark-only layout: Media above one work panel on the left, the editor beside them, and a status bar below. Agent, Review, and Script share the work panel. Their components stay mounted while switching tabs so drafts and native sessions survive navigation. Transcript reads run only while Script is visible. Colours, type, and spacing are tokens in `src/client/styles.css`; the same tokens theme the embedded editor.

Shell controls read and write `src/client/workspace.ts`, a Cutroom-owned store for editor panel visibility and export state. `CutroomEditor` is the only code that mirrors it onto the upstream dock, so the shell does not depend on the embedded editor's layout internals.

`build/studioPlugin.ts` applies explicit, version-checked changes to the published source. It replaces branded chrome, removes hosted catalog and feedback, disables telemetry, and connects agent handoffs. The source package remains an upstream dependency rather than a copied editor fork.

Keep the HyperFrames packages on the same version. An upgrade must review each source transform, run the editing and preview/export tests, and inspect the workspace in a real browser. A successful build alone is insufficient.

For an upstream upgrade, update all `@hyperframes/*` dependencies and the `hyperframes` CLI together, then update `SUPPORTED_VERSION` in the build plugin. Source transforms fail when an expected upstream section changes. Review that change, adjust the integration, and run `bun run check`, `bun test`, and `bun run test:e2e` before packaging. Public editor improvements then come through the dependency. Features exclusive to the proprietary desktop application require independent implementation.

## Timeline engine

`src/shared/timeline/` defines the timeline projection and command union as zod schemas, and a pure `apply(timeline, command)` that the browser and server share. Frames are integers at the root's `data-fps` (30 when absent); HTML and `cutroom.json` keep seconds rounded to six decimals.

Timing model: a clip spans the frames the runtime shows. Source offsets (`data-media-start`) are canonical at the microsecond: parsed once, and command inputs are rounded in the schema. Commands compute source times exactly from frame counts (frame rate as a fraction, times playback rate) and round once, when the timeline is written. Within one batch, 300 one-frame trims land on the same microsecond as one 300-frame trim. Separate requests each store six decimals, so repeated single edits can drift by up to half a microsecond per write; 300 one-frame trims sent one request at a time measured about 100 µs (10.999900 s against 11 s at 30 fps). The projected offset is the source time at the first shown frame; a start the editor wrote, within a microsecond of a frame, never shifts it, so a rounded NTSC start reads back unchanged.

`src/server/timeline/` parses composition HTML and the `cutroom.json` timeline settings into that projection. parse5 builds the HTML spec tree, including implied end tags and foster parenting, and records byte offsets. One scope rule decides what a file renders, and the projection, the readback after an edit, and media discovery all use it: the entry `index.html` renders its live tree, where `<template>` content is inert as in the browser, and any other file is a sub-composition whose content is its first live `<template>` when it has one, as HyperFrames loads it. The offsets let applied commands become attribute edits, element removals, and inserted copies. An element is removed or copied only when it owns its source bytes: every start tag, end tag, and text in them belongs to its subtree, and its whole subtree lies in them. Otherwise the edit is refused, for example when a `<div>` written inside a `<table>` is moved out of it, text inside a table merges into the text before it, or a `</b>` inside the clip closes a bold begun outside it. Media without an authored duration is measured once per file version with ffprobe. The result must parse back to exactly the applied timeline before it is written. `POST /api/cutroom/projects/:id/commands` applies a batch in one store mutation and history window; the revision covers the HTML and its settings. The MCP `timeline_*` tools call the same routes.

Higher video tracks composite above lower ones, as in Resolve. HyperFrames layers clips by CSS `z-index`, not by track, so the editing gestures that move clips between tracks will also maintain `z-index` to keep the stacking in track order. The engine does not write `z-index` yet.

## Native agents

Codex runs through its app-server protocol. Claude Code runs through the Agent SDK with the installed executable and native Claude Code prompt. The adapters preserve the user's home, project directory, configuration, skill discovery, MCP connections, and recorded native session IDs.

The application persists conversation presentation separately from the provider's session. Streaming deltas do not rewrite history on every token. Approvals and questions are explicit pending requests; stale answers are refused. Model changes retain the native session and conversation. A single operation owns each pending or running turn and model change. Stop also cancels preparation, and callbacks from replaced runtimes cannot alter a newer run.

## Rendering and transcription

Preview and export use the public HyperFrames compiler and renderer. Export runs in an isolated Node worker because the producer's Node HTTP adapter modifies globals that Bun's server also uses. Keep `renderWorker.ts` beside `jobs.ts` when packaging. Cancellation waits for the owned process group and partial-output cleanup before shutdown completes.

Local transcription uses an already installed Whisper runtime and complete model. It runs outside the project in a temporary working folder, then imports normalized words through a history transaction. Job cancellation and shutdown await cleanup before closing project histories.

## External agents

Both MCP transports forward to the running server. They do not open a second project store or write files independently. The server binds to loopback and rejects foreign browser origins and rebinding hostnames. This endpoint is intended for agents on the same machine, not public network exposure.

## Background jobs and timeline media cache

Render, transcription, waveform, and filmstrip jobs use the transition table in `src/shared/jobs.ts`. Jobs move from `queued` to `running`, then `done` or `failed`. Queued and running jobs may enter `cancelling`; only cleanup completion moves them to `cancelled`. Running progress uses 0 to 1. The existing render adapter still exposes `rendering` / `complete` and 0 to 100 progress; transcription still exposes `running` / `complete` and 0 to 1. Transcription MCP status forwards that same HTTP response. This version has no render-status MCP tool.

`GET /api/cutroom/projects/:id/media/peaks?path=<project-relative-path>` returns a binary waveform. `GET /api/cutroom/projects/:id/media/filmstrip?path=...` returns JSON with `version`, `interval`, `tileWidth`, `tileHeight`, `columns`, `rows`, `count`, `key`, and `spriteUrl`. Both return `202 {key, job}` with `Retry-After: 1` and `Cache-Control: no-store` while queued or running. Poll the same URL. A failed job returns `422 {key, job}`, including its error. Missing FFmpeg returns 503. No media-cache MCP tools are registered.

The service shares concurrent requests for the same key and admits two worker threads at a time. Each worker runs one FFmpeg process at a time. Audio decoding, peak aggregation, and sprite assembly run outside the server thread. Shutdown cancels the queue, terminates active FFmpeg processes, and awaits scratch cleanup before closing project histories. Paths and cache locations use the project boundary check, including symlinks. FFmpeg accepts local media demuxers only, excluding playlists and network protocols that could follow references beyond that boundary.

The cache lives in `<project>/.cutroom/cache/<key>/`. Its SHA-256 key includes the recipe version, output kind, canonical media path, size, nanosecond mtime, and ctime. This file fingerprint avoids reading an entire large video before a warm response. It invalidates on edits, replacements, and moves, even when a replacement preserves mtime. It is not a byte-content hash, so identical copies can produce separate entries. The source fingerprint is checked again before publishing. Completed directories appear by atomic rename; temporary frames never remain in the cache. Old entries are disposable and are not automatically evicted yet. Failed jobs are remembered in memory, up to 256 entries, to prevent every poll from restarting FFmpeg. A source change or service restart permits another attempt.

Peaks decode the first audio stream to mono signed 16-bit PCM at 8 kHz. The base level contains one min/max pair per 80 samples, or 100 pairs per second. Three additional levels reduce groups of four pairs by their extrema. The final partial bucket and partial mip groups retain their samples. The binary format is little-endian:

| Byte offset | Field                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| 0           | ASCII `CRPK`                                                                                         |
| 4           | uint32 version, currently 1                                                                          |
| 8           | uint32 level count, currently 4                                                                      |
| 12          | uint32 decoded sample rate, currently 8000                                                           |
| 16          | float64 total decoded sample count                                                                   |
| 24          | uint32 base bucket sample count, currently 80                                                        |
| 28          | uint32 reserved, currently 0                                                                         |
| 32          | One 16-byte directory entry per level: uint32 samples per pair, pair count, byte offset, byte length |
| 96          | Level payloads in order, each pair an int16 minimum followed by an int16 maximum                     |

Normalize amplitudes by 32768. Level bucket widths are 0.01, 0.04, 0.16, and 0.64 seconds. Duration is total samples divided by sample rate.

Filmstrips sample the first video stream at 0, 2, 4, ... seconds. They preserve aspect ratio within 160 by 90 pixels, pad with black, and pack at most ten tiles per row into one JPEG. Tiles are ordered left to right, then top to bottom; unused cells in the final row are black. Count comes from decoded frames, so a longer audio stream cannot add phantom tiles. A sprite is limited to 3600 tiles, or two hours of video, to bound sheet dimensions and memory. Audio-only media has no filmstrip; video without audio has no peaks. Unsupported streams return a failed job rather than an empty success.

The source-path endpoints return `Cache-Control: private, max-age=0, must-revalidate` with an ETag derived from the key, so a changed file is rechecked on the next request. A matching `If-None-Match` returns 304. The key-addressed sprite URL returns `private, max-age=31536000, immutable`. These generated assets stay on local disk and are safe to regenerate.

Run `bun scripts/bench-media.ts` to generate a 60-second 1080p testsrc2/sine sample, exercise both HTTP endpoints cold and for 30 warm reads, and capture the waveform and sprite in a dark 1720 by 1050 image. The script prints its temporary output directory and a JSON report with timings, health-request latency during generation, logical and allocated cache bytes, and per-level peak sizes. It retains that throwaway sample and the evidence files for inspection.
