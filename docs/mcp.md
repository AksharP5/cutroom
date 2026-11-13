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
| `timeline_destinations`                                    | Read or set the destination tracks for Insert and Overwrite.       |
| `timeline_copy`                                            | Copy clips and linked partners into the in-app clipboard.          |
| `timeline_view`                                            | Render one frame, or report composition setup errors.              |
| `export_start`, `export_status`, `export_cancel`           | Start, inspect, and cancel the editor's MP4 render jobs.           |

Start with `projects_list` and retain the returned project ID. Before saving an existing file, use `source_read` and pass its exact version to `source_write`. To create a file and its parent folders, pass `expectedVersion: null`; an existing path is rejected with 409. A stale version is rejected. Cutroom's native connection can mutate only the project with its active run; every project mutation checks that token before writing, including source repair. Project creation and import have no existing target and always require separate approval, even with Always allow enabled.

`source_write` only creates or edits composition source types: `.html`, `.htm`, `.css`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.svg`, and `.json`. Any hidden path segment, agent instruction file, or tooling configuration such as `package.json`, `tsconfig.json`, or `vite.config.js` is refused with 403. Symlink targets follow the same rule. These server checks apply to agents and owner requests, regardless of approval or the saved grant. History cannot undo or restore protected instructions/configuration either.

`timeline_view` reports composition script and load failures as an error with the project-relative file and message instead of returning a misleading static frame. The editor shows the same failures in its header. Compiled script filenames remain available in callback locations and error stacks after setup, including timers, animation frames, event handlers and rejected promises. Unattributed failures say `unknown file` rather than guessing the root composition. Repeated errors are grouped per preview load, and dismissal lasts until the source reloads. Repair the source and request the frame again.

## Approvals

Cutroom tells its native agents which of its tools may run without asking. The rule follows what a call can change, not which tool family it belongs to.

| Asks                                                  | Tools                                                                                                                                                                                                                                                                                                                               | Why                                                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never asks                                            | Reads: `projects_list`, `project_read`, `media_list`, `source_marks`, `source_read`, `transcripts_list`, `transcription_status`, `history_list`, `review_list`, `timeline_read`, `timeline_copy`, `timeline_view`, `export_status`                                                                                                  | Nothing changes.                                                                                                                                  |
| Never asks                                            | Queue bookkeeping: `review_claim`, `review_complete`, `review_block`, `review_release`                                                                                                                                                                                                                                              | They only move a note between queue states in `.cutroom/review.json`, outside project content and undo history. No file, clip, or render differs. |
| Never asks                                            | View preferences: `timeline_destinations`                                                                                                                                                                                                                                                                                           | It only chooses the destination tracks in `.cutroom/view.json`, outside project content and undo history. No file, clip, or render differs.       |
| Asks, until you choose **Always allow Cutroom edits** | Project edits: `source_write`, `timeline_edit`, `transcript_edit`, `transcript_import`, `transcription_start`, `history_undo`, `history_redo`, `annotation_add`, `annotation_update`, `annotation_remove`, `review_add`, `review_withdraw`, `review_reorder`, `review_accept`, `review_send_back`, `review_reply`, `review_restore` | They change project files, note content, or cancel a request you made.                                                                            |
| Always asks                                           | `project_create`, `project_import`, `export_start`, `export_cancel`                                                                                                                                                                                                                                                                 | They create a project, write a file outside editable project source, or cancel a running job.                                                     |

Withdrawing a note is not bookkeeping: it cancels a request the owner made, so it asks like an edit. Shell commands, native file tools, and other MCP servers keep the agent's own permissions, including every write outside the project. Your own native ask rule for a Cutroom tool still wins over this table. Outside MCP clients decide for themselves; these rules apply to the agents Cutroom starts.

An approval names what it acts on the way the editor does: a note by its first words, a timeline edit by its clips, a file by its project path. Unnamed clips use their kind or count, such as "Edit a text clip?" or "Edit 3 clips?". Naming waits at most 250 ms before using neutral wording. Ids and tool identifiers appear only under **Details**, which shows the exact request.

## Timeline

`timeline_edit` never rewrites animation scripts. Root tween positions are absolute composition seconds; HyperFrames does not add `data-start`. Commands compare their actual before/after timelines, including ripples that trim and displace clips, and inspect attributable root animation whose origin changed or whose target was copied into a new clip. The edit result acknowledges the saved edit before inspection. For editor edits, a warning follows through the initiating tab's live project SSE stream. The page sends a fresh per-tab origin token with commands and the SSE connection; both the server and client filter it. Observer tabs stay quiet. For MCP callers, the warning follows as a `notifications/message` notification at warning level from `cutroom.animation`. Its data carries `event: "animation-left-behind"`, `projectId`, `requestId` from the originating MCP call, the saved timeline `revision`, `composition`, and `clips` with clip IDs and labels. No warning is returned in `timeline_edit`'s result. Only the initiating editor tab shows a transient toast with Ask agent and Dismiss. Leaving the project clears it. MCP edits notify their caller without showing a toast in observer editor tabs. Sub-composition hosts never warn. Ask agent creates a Review note; no warning state is stored. Pure head/tail trims preserving origin stay quiet. Attribution is best-effort and may nudge on ambiguous scripts or miss unresolvable helpers. Prefer the clip-local [sub-composition authoring pattern](#animated-titles) below.

Timeline edits use frames at the composition's fps. Pass the `revision` from `timeline_read` to `timeline_edit`; each successful edit returns the next revision. A batch applies in order and atomically: if one command cannot apply exactly, the response names its index and error code, and nothing is written. The command list is the `CommandSchema` union in `src/shared/timeline/schema.ts`. [Editing behavior](editing.md#timeline-commands) describes the ripple, link, and lock rules.

`timeline_read.timeline.tracks` includes empty tracks. Lifting, cutting, moving or overwriting their last clips keeps those tracks and their settings. Edits save the track list in `cutroom.json`, so reload and undo/redo preserve it. Use each track's `index` to target an empty row with `insert` or `setTrack`; V1/A1 labels are display numbers within each kind. To remove an unlocked empty track, send `{ "type": "removeTrack", "index": 0 }` through `timeline_edit`. Occupied tracks refuse removal with `unsupported`; locked tracks refuse with `locked`. Remove clips first if you intend to remove their track. Track removal is undoable and leaves other tracks' indices unchanged. The editor offers the same command as Remove empty track in a track header's context menu.

In the editor, drops, moves and overwrite pastes that remove a whole clip show one short notice naming the replaced clip, with Undo. Media or a paste placed over part of a clip names it as partly replaced in the same notice. A clip moved over part of another, and a trim, stay silent.

### Animated titles

Cutroom never rewrites root animation scripts. Moves can leave their absolute positions behind; new razor pieces and pasted copies also have new IDs that root tweens may not target. Give each animated title its own sub-composition file instead. The HyperFrames runtime places a nested composition's timeline at its host clip's start, so every edit carries the animation with it.

On a fresh project, keep the starter's `<script src="assets/vendor/gsap.min.js"></script>` in `index.html`. New projects carry the pinned GSAP distribution with its license notice, so preview, thumbnails and export work offline. Projects created before Cutroom shipped GSAP, and imported projects, have no local copy, and their titles stay static while `timeline_view` still succeeds. To fix one, copy `node_modules/gsap/dist/gsap.min.js` from the Cutroom install (the pinned build, with its license header) to `assets/vendor/gsap.min.js` in the project, then add `<script src="assets/vendor/gsap.min.js"></script>` to `index.html` before any script that uses GSAP.

First call `source_write` with `path: "compositions/lower.html"`, `expectedVersion: null`, and the second HTML block below as `content`. Then `source_read` the root, insert the host clip inside its `main`, and save it with that read's exact version. Keep the rest of the starter HTML. Verify the entrance with `timeline_view` at frames 180, 185 and 195 on a 30 fps project, then export the same range.

```html
<!-- index.html: the host clip -->
<div
  id="lower"
  class="clip"
  data-composition-id="lower"
  data-composition-src="compositions/lower.html"
  data-start="6"
  data-duration="6"
  data-track-index="2"
  data-width="1920"
  data-height="1080"
></div>
```

```html
<!-- compositions/lower.html -->
<template>
  <div
    id="root"
    data-composition-id="lower"
    data-width="1920"
    data-height="1080"
  >
    <p
      id="lower-text"
      style="position:absolute;left:120px;top:600px;margin:0;font-size:64px"
    >
      Ada Lovelace, Founder
    </p>
  </div>
  <script>
    {
      const clip = document
        .querySelector('[data-composition-id="lower"]')
        .closest("[data-start]");
      const inPoint = Number(clip.getAttribute("data-playback-start") ?? 0);
      const out = inPoint + Number(clip.getAttribute("data-duration"));
      const tl = gsap.timeline({ paused: true });
      tl.fromTo(
        "#lower-text",
        { opacity: 0, x: -60 },
        { opacity: 1, x: 0, duration: 0.5 },
        0,
      );
      tl.to("#lower-text", { opacity: 0, duration: 0.4 }, out - 0.4);
      window.__timelines ??= {};
      window.__timelines["lower"] = tl;
    }
  </script>
</template>
```

Tween positions are clip-local seconds. Anchoring the exit to `out` keeps the fade-out when the clip is shortened. A razor cut through the title then fades the first piece at the cut.

`timeline_copy` takes `projectId`, `composition`, `expectedRevision`, and `clipIds`. It returns `{id, clips}` with every linked partner included. The server keeps the copied source bytes, so the snapshot survives cuts, source edits, and timeline switches in the same project until the server restarts. It refuses source-restricted clips by name without changing files or history.

Paste through `timeline_edit` with `{ "type": "paste", "clipboardId": "<id from timeline_copy>", "at": 120, "mode": "overwrite" }`. The earliest copied clip starts at `at`; other clips keep their relative timing. Picture and standalone audio keep their source tracks. All properties and source offsets are retained. New clips have fresh ids and new links within the copied group. Optional `ids` uses the same engine minting rules as razor pieces. Overwrite is the default and clears each copied picture or standalone audio interval on its own track, leaving gaps intact. Linked sound follows the same routing as media drops: it replaces the overwritten picture's partner interval, otherwise uses the first unlocked picture-sound track free over the full sound span, creating a track if needed. It never cuts another pair's sound through the fallback. Both paste modes select all new clips in the editor. `mode: "insert"` opens the full copied span once, splitting spanning clips and shifting unlocked auto-select tracks with the existing sync rules. Restricted spanning clips refuse the entire paste with the auto-select hint. Each paste is one undo step. For Cut, copy first, then send `remove` with `ripple: false`.

Snapshots are project-scoped and cannot be pasted into another project. Destination timelines must use the same frame rate. Relative media paths are rebased when the destination composition lives in another folder. Copies carry their element markup; styles and scripts belonging to the source composition remain there.

`insert.mode` intentionally defaults to `"place"`, which refuses overlaps. UI Media-panel drops default to overwrite; agents must explicitly pass `mode: "overwrite"` to replace destination frames. `mode: "insert"` splits and shifts unlocked auto-select tracks.

To place part of a file, as Insert and Overwrite do from the source viewer, give the range as `clip.mediaStart` in source seconds and `clip.duration` in timeline frames: `{ "type": "insert", "mode": "overwrite", "track": 0, "at": 240, "clip": { "kind": "video", "src": "assets/interview.mp4", "mediaStart": 2, "duration": 90 } }` places three seconds starting two seconds into the file on a 30 fps timeline. A range that runs past the end of the file is refused with `out_of_bounds`. `source_marks` takes `projectId` and a project-relative media `path` and returns `{ in, out }` in source seconds, with exclusive Out. The response also includes `identity.size` and `identity.duration`; duration is the full file length, or five seconds for a still. Either end is `null` when unmarked; use 0 for an unmarked In and the file duration for an unmarked Out. Pass In as `clip.mediaStart` and convert the range length to timeline frames for `clip.duration`. The tool only reads the owner's saved range; `timeline_edit` already places any explicit range, so there is no separate mark-setting tool.

Source marks persist per project in `.cutroom/view.json`, outside timeline undo history. Each path keeps one entry identified by file size and media duration. Touching, copying or restoring identical media keeps the marks. A changed size or duration starts unmarked; removed files leave one dormant entry and reads return not found. Source-mark saves carry the identity read by the editor; a save for a replaced file is refused with 409. Saves from one editor are serialized per project/file and pending values coalesce across navigation. Superseded reads cannot replace newer choices or cross-tab updates. Network and 5xx save failures retain the latest queued value and retry on the project SSE reconnect or when the file is reopened. An identity conflict drops the rejected value. Valid entries survive malformed neighbours; truncated JSON uses defaults. Source position is not saved; opening a file seeks to its In mark.

Queued view preferences live in the tab's memory. Closing the tab before a value is sent loses it. If two tabs edit the same file's marks simultaneously, request arrival order wins, rather than the time of the latest human action.

Video with sound becomes a muted picture and a linked audio clip. Overwrite routes sound to the overwritten picture's linked audio track, even when a different picture-sound track comes first. A locked partner track or pictures with partners on different audio tracks refuse the edit. With no linked partner under the drop, routing falls back to the first unlocked audio track that holds only linked picture sound and is free over the whole interval, creating one if needed; the fallback never cuts existing audio. Place and insert also require room for the full interval after any ripple. A gap on a music or voice track does not qualify. Silent video and `clip.muted: true` stay video-only. `linkedAudio.id` optionally names the new sound clip. `linkedAudio.track` sends the sound to that audio track instead of routing it: overwrite replaces what is there, insert opens it with the other rippled tracks, and place needs room. A video track is refused with `track_kind`.

`timeline_destinations` takes `projectId` and `composition` and returns `{ video, audio }`: the track indexes where the owner's Insert (F9), Overwrite (F10) and Media menu placements go, as the track headers show them. With nothing chosen they are the first track of each kind. Pass `video` or `audio` to choose a track; the open editor's headers follow at once. An index that is not a track of that kind on the timeline is refused with `not_found`. Destinations are view preferences in `.cutroom/view.json`, outside undo history, and `timeline_edit` never reads them. To place media where the owner would, pass them yourself: `{ "type": "insert", "mode": "overwrite", "track": <video>, "at": 240, "clip": { ... }, "linkedAudio": { "track": <audio> } }`, or `track: <audio>` for an audio file.

`setClip.opacity` sets static inline opacity from 0 to 1, canonical to six decimals; `null` removes the inline override. `setTiming` sets `playbackRate` or `mediaStart` in source seconds while keeping timeline duration and linked source sync. Both use the same commands and undo history as the inspector. Timeline reads also include `clipEdits`, the recent owner/agent ledger, and `agentChanges`, the clips still underlined for review.

`setClip.x` and `setClip.y` are additive offsets in composition pixels, canonical to six decimals, not absolute canvas coordinates. Positive X moves right and positive Y moves down. Null or zero clears that axis; reads return null when an axis has no offset. `{type:"setClip", clipId:"title", x:null, y:null}` resets both in one undo step. Only the named visual clip moves; linked audio has no position and rejects position edits.

`clip.text` is a text element's words: its text nodes, with `<br>` read as a line break and whitespace collapsed as HTML renders it by default. Inline `white-space: pre-line` preserves source newlines. Multiline text whose whitespace depends on stylesheets or inheritance retains its source newlines and is source-only when the parser cannot establish its cascade. It is null for media and for elements with no text. `setClip.text` replaces those words in the source, HTML-escaped, with each newline written as `<br>`; the whitespace around them stays as authored. One call is one undo step, named "Set text to …" in history, and the editor's inspector uses the same command:

```json
{ "type": "setClip", "clipId": "headline", "text": "Spring\nlaunch" }
```

The edit is refused with `unsupported`, and nothing is written, when the clip's `sourceRestrictions.text` gives a reason: the text has markup inside it (the read still returns the flattened words), it keeps exact spacing or has uncertain multiline whitespace, the element has no closing tag, or a script in the composition writes it by id. That last check finds `textContent`, `innerText`, `innerHTML` and similar writes on the element, directly or through a variable it was read into, and GSAP `text` tweens. A script that reaches the element another way can replace the saved words. The edit still commits. Verify the result with `timeline_view` at relevant frames. In the editor, Text warns at the shown timecode when the selected clip's rendered words differ from the committed text, after settled paint and on later seeks. That warning never blocks editing. Empty text is refused; remove the clip instead.

The pinned HyperFrames 0.9.26 runtime composes `data-x`/`data-y` minus captured `data-hf-edit-base-x`/`data-hf-edit-base-y` with authored CSS position, transforms and GSAP animation. Cutroom captures both existing baselines on the first edit. The runtime reapplies offsets after seeks in preview and render.

A composition's own animation can override Position. Commands still save the offset. Use `timeline_view` frames to verify the result. In the editor, Transform warns at the displayed timecode when the selected clip's translate differs from the runtime's composed value, or scale, rotation or zoom changes the offset's composition-pixel size. The warning clears when Position holds again and never blocks editing.

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

Claim a note before working on it, then complete it with a short note or block it with a question. Claim and complete also accept new notes, so an outside client can work them directly. To claim a blocked note the owner answered in a message, pass that answer; it is saved on the note. `review_complete` reads the latest existing history entry unless you pass a `revision`. It never initializes history; without existing history it records no revision. Claim, complete, block, and release only write `.cutroom/review.json`. A claim lasts for the current Cutroom run, or for the server's lifetime when made by an outside client; unfinished notes then return to the queue. An outside client acts as the owner's delegate: it may also accept, send back, answer, restore, and release notes, and each of those is recorded as an outside agent. Cutroom's own agent may release its claim but cannot accept, send back, answer, or restore its own work. Once sent, a note cannot be edited with `annotation_update` or removed with `annotation_remove`; withdraw it instead. If `history_undo` or `history_redo` removes or changes a sent note's content, the request becomes withdrawn and is credited to you.

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

Media rename integration: after the filesystem rename succeeds, call `moveSourceMarks(project, from, to)` from `src/server/projects/view.ts`, with project-relative paths. It moves the path's entry through the shared view-state write queue, including already queued saves, and removes the old key. If the source has no entry, it clears the destination entry so an unmarked replacement cannot inherit stale marks. It does not rename media or add an undo step. The media-rename operation owns the filesystem change and its history.
