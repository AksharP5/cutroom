# MCP tools

The stdio bridge connects to a running local Cutroom server. It accepts only loopback HTTP origins. The local HTTP MCP endpoint is `/mcp`.

| Tool                                                       | Behavior                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `projects_list`                                            | List registered project folders.                                   |
| `project_create`, `project_import`                         | Create a composition or register an existing folder.               |
| `project_read`                                             | Read annotations and transcript metadata.                          |
| `media_list`                                               | Inspect local media elements and their timing.                     |
| `source_read`, `source_write`                              | Read source and save with its exact expected version.              |
| `annotation_add`, `annotation_update`, `annotation_remove` | Add a new timed note, edit its content, or remove an unsent note.  |
| `review_list`, `review_add`                                | Read the review queue or add a queued request.                     |
| `review_claim`, `review_complete`, `review_block`          | Start, finish, or ask a question about a queued note.              |
| `review_reorder`                                           | Move a note before another, or to the end, for the owner.          |
| `review_withdraw`                                          | Withdraw a note the owner's newer message cancels.                 |
| `review_accept`, `review_send_back`, `review_reply`        | Act for the owner on done or blocked notes (outside clients only). |
| `review_restore`, `review_release`                         | Re-queue a withdrawn note or a stuck claim.                        |
| `transcripts_list`, `transcript_import`, `transcript_edit` | Read word timing, import a script, and cut or restore words.       |
| `transcription_start`, `transcription_status`              | Run and inspect local transcription.                               |
| `history_list`, `history_undo`, `history_redo`             | Use the editor's shared history.                                   |
| `timeline_read`, `timeline_edit`                           | Read the timeline in frames and apply a batch of commands.         |
| `timeline_view`                                            | Render one timeline frame as an image.                             |
| `export_start`, `export_status`, `export_cancel`           | Start, inspect, and cancel the editor's MP4 render jobs.           |

Start with `projects_list` and retain the returned project ID. Before a source save, use `source_read` and pass its exact version to `source_write`. A stale version is rejected. Cutroom's native connection can mutate only the project with its active run; every project mutation checks that token before writing, including source repair. Project creation and import have no existing target and always require separate approval, even with Always allow enabled.

`source_write` only edits composition source types: `.html`, `.htm`, `.css`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.svg`, and `.json`. Any hidden path segment, agent instruction file, or tooling configuration such as `package.json`, `tsconfig.json`, or `vite.config.js` is refused with 403. Symlink targets follow the same rule. These server checks apply to agents and owner requests, regardless of approval or the saved grant. History cannot undo or restore protected instructions/configuration either.

## Timeline

Timeline edits use frames at the composition's fps. Pass the `revision` from `timeline_read` to `timeline_edit`; each successful edit returns the next revision. A batch applies in order and atomically: if one command cannot apply exactly, the response names its index and error code, and nothing is written. The command list is the `CommandSchema` union in `src/shared/timeline/schema.ts`. [Editing behavior](editing.md#timeline-commands) describes the ripple, link, and lock rules.

`insert.mode` intentionally defaults to `"place"`, which refuses overlaps. UI Media-panel drops default to overwrite; agents must explicitly pass `mode: "overwrite"` to replace destination frames. `mode: "insert"` splits and shifts unlocked auto-select tracks.

Video with sound becomes a muted picture and a linked audio clip. Overwrite routes sound to the overwritten picture's linked audio track, even when a different picture-sound track comes first. A locked partner track or pictures with partners on different audio tracks refuse the edit. With no linked partner under the drop, routing falls back to the first unlocked audio track that holds only linked picture sound and is free over the whole interval, creating one if needed; the fallback never cuts existing audio. Place and insert also require room for the full interval after any ripple. A gap on a music or voice track does not qualify. Silent video and `clip.muted: true` stay video-only. `linkedAudio.id` optionally names the new sound clip; it does not select a destination track.

`setClip.opacity` sets static inline opacity from 0 to 1, canonical to six decimals; `null` removes the inline override. `setTiming` sets `playbackRate` or `mediaStart` in source seconds while keeping timeline duration and linked source sync. Both use the same commands and undo history as the inspector. Timeline reads also include `clipEdits`, the recent owner/agent ledger, and `agentChanges`, the clips still underlined for review.

`label` is the past-tense summary the owner sees in history and in the inspector's Changes list. Omit it and the edit is named from its commands, the same way the editor names its own edits (for example "Moved 15 frames right" or "Set gain to -6.0 dB").

For example, this razors every unlocked auto-select track at frame 90 and ripple deletes the first half of a linked clip:

```json
{
  "projectId": "…",
  "expectedRevision": "…",
  "label": "Cut the intro",
  "commands": [
    { "type": "split", "at": 90 },
    { "type": "remove", "clipIds": ["talk"], "ripple": true }
  ]
}
```

New pieces get ids no clip in the project has had, such as `talk-k7q2xa`. To edit a piece in the same batch that cuts it, name it, with a list per source clip in the order the command cuts it (a ripple through several ranges cuts a spanning clip once per range, last range first): `{ "type": "split", "at": 90, "ids": { "talk": ["talk-end-q3x8"] } }`. A name must never have been used in the project, even by a clip that was deleted or undone; any other name is refused with `duplicate_id`, so add a suffix of your own that is unlikely to repeat.

## Review queue

Each message from Cutroom's agent panel includes a digest of unfinished notes and the project ID. Reconcile the message with that queue before working: withdraw what it cancels, with a reason. For a replacement, add the new request with `review_add`, then withdraw the old note with `replacedBy`. Each Cutroom conversation's native agent reaches these tools through a bridge carrying that conversation's own token (for Codex, set per thread), so the server credits its actions to the running message and stamps withdrawals with it. A token only works on its own project while its run is active; any other use is refused with 409. Every other client, including this server's `/mcp` endpoint and the stdio bridge from Settings, is recorded as an outside agent.

Claim a note before working on it, then complete it with a short note or block it with a question. Claim and complete also accept new notes, so an outside client can work them directly. To claim a blocked note the owner answered in a message, pass that answer; it is saved on the note. `review_complete` records the latest history entry unless you pass a `revision`. A claim lasts for the current Cutroom run, or for the server's lifetime when made by an outside client; unfinished notes then return to the queue. An outside client acts as the owner's delegate: it may also accept, send back, answer, restore, and release notes, and each of those is recorded as an outside agent. Cutroom's own agent may release its claim but cannot accept, send back, answer, or restore its own work. Once sent, a note cannot be edited with `annotation_update` or removed with `annotation_remove`; withdraw it instead. If `history_undo` or `history_redo` removes or changes a sent note's content, the request becomes withdrawn and is credited to you.

MCP mutations use the same server commands as the interface. Edits to project files and note content appear in its undo history; review status lives outside it. File watchers update the visible preview and the Review panel.

`review_reorder` takes `noteId` and `beforeId`. Set `beforeId` to another unfinished note or `null` for the end. This changes the saved owner order used by Review, note numbers, and the next agent digest. Cutroom's own agent cannot reorder; outside clients may act for the owner.

Pass `noteId` to `source_write`, `timeline_edit`, or `transcript_edit` when the run has several claimed notes. It must name a note claimed by that run. With one claimed note it is automatic; ambiguous edits are refused before writing, so accepting one note never accepts another note's clips.

## Export

`export_start` takes `projectId` and optional `range`, `quality`, `filename`, and `directory`. It uses the editor's render route and job registry over both the stdio bridge and HTTP `/mcp`. The bridge sends the local Origin header; clients do not need to call the render route themselves.

- Omit `range` to use In to Out when both marks exist, otherwise the whole timeline. `"marks"` requires both marks, `"timeline"` exports everything, and `{ "start": 30, "end": 90 }` exports those half-open project frames. Out is exclusive, as in `timeline_read`. Size and rational fps come from the project.
- `quality` is `"draft"`, `"standard"`, or `"high"`, with Standard as the default, using the dialog's producer presets.
- Omit `directory` to create the project's `.cutroom/renders` folder on demand. A chosen directory must be an absolute existing folder, under the same path validation as the dialog. App-state folders cannot be redirected through symlinks.
- Omit `filename` to choose the next free project name, then a suffix from 2, in the chosen folder. An explicit filename must end in `.mp4` and cannot contain folders. Names are suggestions until publication. A taken destination fails without replacing it, even if another file appears during rendering.

Only one export can run at a time across all projects, whether started in the editor or over MCP. A second start is refused with the running export's project, filename, and job ID. Wait for it to finish, or use `export_cancel` with that job ID and wait for cleanup before starting another export.

The response includes `jobId` and `outputPath`. `export_status` takes `jobId` and returns `status`, `stage`, `stageProgress`, `progress` from 0 to 100, `estimate`, `outputPath`, `sizeBytes`, `error`, and timing/range/preset details. `estimate` is either null or `{ milliseconds, stage }` for the current stage, using the dialog's measured frame-rate estimator. Preparation, assembly, retries, and stalled progress do not claim an estimate. `sizeBytes` is available once published; `error` preserves the failure cause, including cleanup errors. Completed, failed, and cancelled jobs remain queryable for five minutes after cleanup, while the server remains running.

`export_cancel` takes `jobId` and waits for worker shutdown and partial-output cleanup before returning `cancelled`. Cleanup failure returns an error and leaves the job `failed`. Cancellation after publication keeps the completed file. A native Cutroom agent can start and cancel jobs only for its active run's project. `export_status` is read-only. Start and cancel require separate native approval, including when **Always allow Cutroom edits** is enabled, because exports create output files beyond editable project source.

Agent jobs appear in the open editor's Export indicator. The dialog follows the running job through completion or cancellation even if you switch projects or reload in another one, and `export_status` also reads owner-started jobs. Existing progress and inline-video routes remain `/api/render/:jobId/progress` and `/view`.

For example, after `projects_list` and `timeline_read`:

```json
{ "name": "export_start", "arguments": { "projectId": "…" } }
```

Both marks select the marked range automatically. Retain the returned `jobId`, then poll until `status` is `complete`, `failed`, or `cancelled`:

```json
{ "name": "export_status", "arguments": { "jobId": "…" } }
```

A completed result includes the saved path and byte size. To export the entire timeline despite the marks, choose it explicitly:

```json
{
  "name": "export_start",
  "arguments": {
    "projectId": "…",
    "range": "timeline",
    "quality": "high",
    "filename": "Final.mp4"
  }
}
```

To stop an active job and await cleanup:

```json
{ "name": "export_cancel", "arguments": { "jobId": "…" } }
```
