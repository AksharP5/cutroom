# MCP tools

The stdio bridge connects to a running local Cutroom server. It accepts only loopback HTTP origins. The local HTTP MCP endpoint is `/mcp`.

| Tool                                                            | Behavior                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `projects_list`                                                 | List registered project folders.                                            |
| `project_create`, `project_import`                              | Create a composition or register an existing folder.                        |
| `project_read`                                                  | Read annotations and transcript metadata.                                   |
| `project_lint`                                                  | Run HyperFrames lint: counts and findings, errors first.                    |
| `media_list`                                                    | Inspect local media elements and their timing.                              |
| `media_rename`, `media_remove`                                  | Rename a media file with its references, or move it to the trash.           |
| `source_read`, `source_write`                                   | Read source and save with its exact expected version.                       |
| `motion_read`, `motion_update`                                  | Inspect existing inline GSAP motion and edit one authored literal.          |
| `annotation_add`, `annotation_update`, `annotation_remove`      | Add a new timed note, edit its content, or remove an unsent note.           |
| `review_list`, `review_add`                                     | Read the review queue or add a queued request.                              |
| `review_claim`, `review_complete`, `review_block`               | Start, finish, or ask a question about a queued note.                       |
| `review_reorder`                                                | Move a note before another, or to the end, for the owner.                   |
| `review_withdraw`                                               | Withdraw a note the owner's newer message cancels.                          |
| `review_accept`, `review_send_back`, `review_reply`             | Act for the owner on done or blocked notes (outside clients only).          |
| `review_restore`, `review_release`                              | Re-queue a withdrawn note or a stuck claim.                                 |
| `transcripts_list`, `transcript_import`, `transcript_edit`      | Read word timing, import a script, and cut or restore words.                |
| `transcription_start`, `transcription_status`                   | Run and inspect local transcription.                                        |
| `subtitles_import`                                              | Attach an SRT or WebVTT file to a media element as its transcript.          |
| `captions_list`, `captions_edit`, `captions_export`             | Read, add, regenerate, restyle and correct captions, and export SRT or VTT. |
| `variables_list`, `variables_preview`                           | Read a composition's variables, and set the overrides the viewer previews.  |
| `variables_set_default`, `variables_declare`                    | Write a variable's default, or declare one and bind it to a clip.           |
| `fonts_list`, `fonts_add`                                       | List the project's and Google's fonts; download a Google font into it.      |
| `history_list`, `history_undo`, `history_redo`                  | Use the editor's shared history.                                            |
| `timeline_read`, `timeline_edit`                                | Read the timeline in frames and apply a batch of commands.                  |
| `timeline_destinations`                                         | Read or set the destination tracks for Insert and Overwrite.                |
| `timeline_copy`                                                 | Copy clips and linked partners into the in-app clipboard.                   |
| `timeline_view`                                                 | Render up to eight frames, or report composition setup errors.              |
| `export_start`, `export_status`, `export_cancel`, `export_list` | Start, inspect, and cancel the editor's render jobs, and list past renders. |
| `audio_duck`, `audio_loudness`                                  | Duck a bed under the voice; normalize clips or the mix to LUFS.             |

Start with `projects_list` and retain the returned project ID. Before saving an existing file, use `source_read` and pass its exact version to `source_write`. To create a file and its parent folders, pass `expectedVersion: null`; an existing path is rejected with 409. A stale version is rejected. Cutroom's native connection can mutate only the project with its active run; every project mutation checks that token before writing, including source repair. Project creation and import have no existing target and always require separate approval, even with Always allow enabled.

`source_write` only creates or edits composition source types: `.html`, `.htm`, `.css`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.svg`, and `.json`. Any hidden path segment, agent instruction file, or tooling configuration such as `package.json`, `tsconfig.json`, or `vite.config.js` is refused with 403. Symlink targets follow the same rule. These server checks apply to agents and owner requests, regardless of approval or the saved grant. History cannot undo or restore protected instructions/configuration either.

`media_list` gives a video the browser cannot decode, such as HEVC, ProRes or DNxHR, a `proxy` field: the job state of the editing proxy the preview plays (`queued`, `running` with `progress` from 0 to 1, `done`, or `failed` with `error`). Asking starts it. While it runs, the editor plays that clip piece by piece and makes the part at the playhead first; `timeline_view` and exports read the original file. [Details](architecture.md#editing-proxies).

`media_rename` takes a media file's project path and its new name with the same extension. The file stays in its folder, every reference in the project's sources follows it, and the rename is one undo step. `media_remove` moves a file to the project's `trash` folder and `history_undo` moves it back. A file used by clips, CSS backgrounds or composition scripts is refused with 409 and its use count; pass `confirmUsed: true` to remove it anyway, which leaves those clips in place playing nothing. Files already in `trash` are not media: neither tool takes them. [Details](editing.md#media-files).

`timeline_view` takes `frame` for one frame or `frames` for up to eight, and returns one JPEG per frame, each followed by a line such as `Frame 30 (1.000s)`. `width` scales each image down to that many pixels wide, keeping the aspect ratio, and never past the composition's size; without it, images are full size. A 480 px frame is about 4 KB against about 27 KB at 1920 px, and is enough to check layout, text and timing. Scaling uses FFmpeg, which exports already need.

`timeline_view` reports composition script and load failures as an error with the project-relative file and message instead of returning a misleading static frame. The editor shows the same failures in its header. Compiled script filenames remain available in callback locations and error stacks after setup, including timers, animation frames, event handlers and rejected promises. Unattributed failures say `unknown file` rather than guessing the root composition. Repeated errors are grouped per preview load, and dismissal lasts until the source reloads. Repair the source and request the frame again.

## Approvals

Cutroom tells its native agents which of its tools may run without asking. The rule follows what a call can change, not which tool family it belongs to.

| Asks                                                  | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Why                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never asks                                            | Reads: `projects_list`, `project_read`, `project_lint`, `media_list`, `source_marks`, `source_read`, `transcripts_list`, `transcription_status`, `captions_list`, `captions_export`, `variables_list`, `fonts_list`, `history_list`, `review_list`, `timeline_read`, `timeline_copy`, `timeline_view`, `export_status`, `export_list`                                                                                                                                                                      | Nothing changes.                                                                                                                                  |
| Never asks                                            | Queue bookkeeping: `review_claim`, `review_complete`, `review_block`, `review_release`                                                                                                                                                                                                                                                                                                                                                                                                                     | They only move a note between queue states in `.cutroom/review.json`, outside project content and undo history. No file, clip, or render differs. |
| Never asks                                            | View preferences: `timeline_destinations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | It only chooses the destination tracks in `.cutroom/view.json`, outside project content and undo history. No file, clip, or render differs.       |
| Asks, until you choose **Always allow Cutroom edits** | Project edits: `source_write`, `media_rename`, `media_remove`, `timeline_edit`, `transcript_edit`, `transcript_import`, `transcription_start`, `subtitles_import`, `captions_edit`, `variables_preview`, `variables_set_default`, `variables_declare`, `variables_bind`, `fonts_add`, `history_undo`, `history_redo`, `annotation_add`, `annotation_update`, `annotation_remove`, `review_add`, `review_withdraw`, `review_reorder`, `review_accept`, `review_send_back`, `review_reply`, `review_restore` | They change project files, note content, or cancel a request you made.                                                                            |
| Always asks                                           | `project_create`, `project_import`, `export_start`, `export_cancel`                                                                                                                                                                                                                                                                                                                                                                                                                                        | They create a project, write a file outside editable project source, or cancel a running job.                                                     |

Withdrawing a note is not bookkeeping: it cancels a request the owner made, so it asks like an edit. Shell commands, native file tools, and other MCP servers keep the agent's own permissions, including every write outside the project. Your own native ask rule for a Cutroom tool still wins over this table. Outside MCP clients decide for themselves; these rules apply to the agents Cutroom starts.

Timeline approvals list each pending command in plain words through the shared edit labels. Clip names and timecodes use the matching open composition; unavailable compositions use exact frame counts. Commands later in a batch account for earlier commands. Media overwrite insertions show destination tracks and the affected time range. Missing track context falls back to the track index, and marker edits use neutral wording when their existence is unknown. Long lists scroll with Allow and Deny kept visible. Other approvals name their note or file, with naming bounded at 250 ms. Ids and tool identifiers appear only under **Details**, which shows the exact request. MCP and native agent instructions allow review notes in replies when the turn changed one, when you explicitly ask about notes, or when needed to explain a blocker. Otherwise they omit recaps of untouched queued notes.

## Timeline

`timeline_edit` never rewrites animation scripts. Root tween positions are absolute composition seconds; HyperFrames does not add `data-start`. Commands compare their actual before/after timelines, including ripples that trim and displace clips, and inspect attributable root animation whose origin changed or whose target was copied into a new clip. The edit result acknowledges the saved edit before inspection. For editor edits, a warning follows through the initiating tab's live project SSE stream. The page sends a fresh per-tab origin token with commands and the SSE connection; both the server and client filter it. Observer tabs stay quiet. For MCP callers, the warning follows as a `notifications/message` notification at warning level from `cutroom.animation`. Its data carries `event: "animation-left-behind"`, `projectId`, `requestId` from the originating MCP call, the saved timeline `revision`, `composition`, and `clips` with clip IDs and labels. No warning is returned in `timeline_edit`'s result. The result ends with one more text block saying what the edit did and naming its clips, such as "Extended still.png by 1 s"; the agent panel shows it as the call's row. Each command is described from its immediate before-state in the batch. An optional `label` stays literal text, limited to 120 characters, and follows the factual outcome as `Agent label: "..."`. Only the initiating editor tab shows a transient toast with Ask agent and Dismiss. Leaving the project clears it. MCP edits notify their caller without showing a toast in observer editor tabs. Sub-composition hosts never warn. Ask agent creates a Review note; no warning state is stored. Pure head/tail trims preserving origin stay quiet. Attribution is best-effort and may nudge on ambiguous scripts or miss unresolvable helpers. Prefer the clip-local [sub-composition authoring pattern](#animated-titles) below.

Timeline edits use frames at the composition's fps. Pass the `revision` from `timeline_read` to `timeline_edit`; each successful edit returns the next revision. An edit's reply holds that revision and only what the edit changed, so an agent can keep editing without reading again:

```json
{
  "revision": "…",
  "composition": "index.html",
  "changes": {
    "clips": {
      "added": [
        {
          "id": "caption-tail",
          "start": 120,
          "duration": 60,
          "…": "every field"
        }
      ],
      "changed": [{ "id": "caption", "duration": 60 }],
      "removed": ["rule"]
    },
    "markers": { "added": [{ "id": "beat", "frame": 30, "…": "every field" }] }
  }
}
```

`changes.clips`, `changes.tracks`, `changes.markers` and `changes.authoredAudioGroups` each list `added` (complete objects, so the ids of razor pieces, inserts and pastes are known), `changed` (the id or track index with the new value of each field that changed; `null` means the field was cleared) and `removed` (ids or indexes). Groups and lists with nothing in them are left out. `changes.range` and `changes.duration` appear when the in/out range or the timeline length changed. `skippedClips` names clips an auto-select razor left whole, and `warnings` names clips on an edited track that track gain skips. Pass `fullTimeline: true` to also get the whole `timeline` and `agentChanges`, exactly as a read returns them. On a 13-clip project, adding a marker answers in about 0.3 KB instead of 36 KB; on 300 clips, a ripple delete answers in about 9 KB instead of 284 KB.

`timeline_read` takes optional `from` and `to` frames (half-open) and `tracks`, a list of track indexes, and then returns only the clips and markers that overlap that range on those tracks. `timeline.tracks`, `timeline.authoredAudioGroups`, the range, the duration and the revision always describe the whole timeline, so the revision is valid for an edit anywhere. A batch applies in order and atomically: if one command cannot apply exactly, the response names its index and error code, and nothing is written. The command list is the `CommandSchema` union in `src/shared/timeline/schema.ts`. [Editing behavior](editing.md#timeline-commands) describes the ripple, link, and lock rules.

Resolve's gap, slip, slide and link edits are commands too, each one undo step with the same reply:

```json
[
  { "type": "closeGap", "track": 0, "at": 95 },
  { "type": "slip", "clipId": "talk", "by": 12 },
  { "type": "slide", "clipIds": ["broll"], "by": -8 },
  { "type": "unlink", "clipIds": ["talk"] },
  { "type": "link", "clipIds": ["talk", "talk-sound"] }
]
```

`closeGap` closes the gap around a frame on a track, rippling unlocked auto-select tracks, and refuses when a clip on one of them is in the gap. `slip` shows later source with a positive `by` (earlier with a negative one), with linked partners unless `linked: false`. `slide` moves clips between their neighbours as one block, and the neighbours and their linked sound trim to follow. Keyframes and volume points follow slipped content as they do in a trim. Both refuse with how far the clip can go. A linked picture and sound that play different moments of their file carry `syncOffset` in reads and replies, the frames the clip plays its source later than its partner; moving it by `-syncOffset` or slipping it by `syncOffset` resyncs it. [The rules](editing.md).

`timeline_read.timeline.tracks` includes empty tracks. Lifting, cutting, moving or overwriting their last clips keeps those tracks and their settings. Edits save the track list in `cutroom.json`, so reload and undo/redo preserve it. Each track carries `volume`, its linear gain (1 = 0 dB), which plays on top of every clip on the track in preview and export; set it with `setTrack` (`{ "type": "setTrack", "index": 2, "volume": 0.125 }` turns a music track down 18 dB, however many pieces its bed is cut into). A clip's `volume` stays canonical in `data-volume`. Track gain uses an independent `<hf-audio-group>` stage, including for embedded video sound and GSAP volume tweens. Each stage accepts up to +12 dB; clip and track gains can combine above +12 dB. A clip that already belongs to an authored audio group is excluded from track gain and carries a plain `trackGainWarning` in reads; an edit that changes its track lists it under `warnings`. Keep that membership intact and report the exclusion to the user, especially when setting track gain to zero. Track mute and solo still apply to those clips. Use each track's `index` to target an empty row with `insert` or `setTrack`; V1/A1 labels are display numbers within each kind. To remove an unlocked empty track, send `{ "type": "removeTrack", "index": 0 }` through `timeline_edit`. Occupied tracks refuse removal with `unsupported`; locked tracks refuse with `locked`. Remove clips first if you intend to remove their track. Track removal is undoable and leaves other tracks' indices unchanged. The editor offers the same command as Remove empty track in a track header's context menu.

### Authored audio group gain

A clip's `authoredAudioGroupId` is its bus membership. Find the matching declaration and its linear gain in `timeline.authoredAudioGroups`, which includes buses with no current members. The Inspector's Group gain field and `{ "type": "setAudioGroup", "clipId": "dialogue-1", "volume": 0.5 }` both change the declared bus in one undo step. Clip gain, routing, FX, mute and automation are preserved. A clip that references an undeclared bus keeps its membership and has no bus gain to edit. Edits are refused when a member is on a locked track or the declaration carries a `sourceRestriction`, such as a duplicate ID, members outside this timeline, or external scenes that can inherit the parent bus.

### Volume automation

A clip with sound can carry a volume envelope, which the editor draws as points on its gain line. Reads give it as `automation: { "volume": [{ "frame": 90, "gain": 1 }, { "frame": 150, "gain": 0.25 }] }`: clip-local frames (0 is the clip's first frame), and gain as a linear level on top of the clip's own gain, so 1 changes nothing and 0.25 is -12 dB. The level runs straight between points, and the first and last points hold before and after them. `lanes` names any effect-parameter lanes the clip also has, without their points. `automation` is `null` when the clip has none.

```json
{
  "type": "setClip",
  "clipId": "music",
  "automation": {
    "volume": [
      { "frame": 0, "gain": 1 },
      { "frame": 90, "gain": 1 },
      { "frame": 105, "gain": 0.25 }
    ]
  }
}
```

`setClip.automation.volume` replaces the whole envelope with the points given, in any order; two points on one frame are refused, and so is an envelope on a clip without sound. Frames may be fractional, as baked ramps read back. `[]` removes the envelope and keeps effect lanes; `automation: null` removes every lane. The envelope multiplies with the clip's gain, its fades and its track's gain. It is clip-local, so it moves with the clip; a tail trim keeps it, and a razor or a head trim keeps the level at the cut but drops points before the clip's new first frame. A transition on a clip with an envelope crossfades with straight fades. A baked ramp may bend between its points; writing points back makes straight runs. Preview and export play the same envelope.

### Audio effects

A clip with sound, and a track, carry an effect chain in `fx`, in signal order. Reads list each effect as `{ "id": "n2", "type": "limiter", "params": { "limit": -6 } }`, leaving out parameters at their defaults; `enabled: false` marks a bypassed effect, `label` its name in the rack, and `preset` the preset that added it. `setClip.fx` and `setTrack.fx` take the whole chain:

```json
{
  "type": "setClip",
  "clipId": "voice",
  "fx": [
    { "preset": "voice-clean" },
    { "type": "limiter", "params": { "limit": -3 } }
  ]
}
```

An entry is an effect, `{ type, params, enabled, label, id }`, or a preset, `{ preset }`, which adds that preset's effects in order. An entry naming an existing `id` of the same type keeps the values it leaves out, so `{ "id": "n2", "type": "limiter", "enabled": false }` bypasses that limiter and changes nothing else; new effects get the next free id, `n1`, `n2` and so on. `[]` removes every effect. Types are `gain`, `peaking`, `lowshelf`, `highshelf`, `highpass`, `lowpass`, `compressor`, `limiter`, `truepeak`, `gate`, `saturate`, `bitcrush`, `pitchshift`, `delay`, `chorus`, `phaser` and `reverb`; presets are HyperFrames' `voice-clean`, `voice-broadcast`, `voice-warm`, `rumble-cut`, `room-gate`, `boom-tame`, `harsh-tame`, `telephone`, `radio-am`, `megaphone`, `lofi-tape`, `pa-system`, `intercom`, `doofus-worble`, `chipmunk`, `giant`, `monster`, `room-tight`, `room-natural`, `hall`, `slap-echo` and `dub-throw`. Parameters are numbers in the effect's own units within its range, or one of its choices; anything else is refused with the effect's range, and nothing typed reaches the audio graph as text. A chain holds up to 32 effects. A clip's chain is its `data-fx-chain`; a track's goes on its bus and processes every clip on the track except those with `trackGainWarning`. A clip without sound, or one whose authored chain Cutroom cannot read (`sourceRestrictions.fx` says why), is refused. Editing a chain keeps what a voiceover carve or HyperFrames Studio marked on the effects it keeps. Each command is one undo step, and preview and export play the same chain.

### Ducking and loudness

`audio_duck` lowers a bed under the voice. Name the `bed` clip and, optionally, its `voices`; without them, every other clip with sound that plays over the bed on another track and is not named like music, a score or an effect is a voice. Speech is found in what each voice plays (HyperFrames' silence detection, with pauses a third of a second or longer counted as silence), and the bed comes down by `depth` dB (default -12) while any voice speaks: down over `attack` seconds (default 0.25) ending as speech starts, back up over `release` seconds (default 0.6) after it stops, and held down through pauses too short to come back up in. The result is the bed's volume points, multiplied into the ones it had, so they read back in `automation.volume` and the owner can drag them. Voices playing faster than 2x or slower than 0.5x are refused. The reply's `measured` lists the voices and how many stretches of speech were found.

`audio_loudness` normalizes with FFmpeg's EBU R128 meter, as gain only. With `clipIds`, each clip is measured as it plays at its file's own level and gets the clip gain that brings it to `target` LUFS (default -16), held at +12 dB; `measured.clips` gives each one's measured LUFS, true peak and the level it reaches. With `jobId`, a finished whole-timeline export from `export_start` is measured and a Loudness gain effect (id `loudness`) on the master bus is set so the next export reaches `target`; export again to deliver it. The master bus is `timeline.masterFx`, the composition root's chain, which `setMaster` replaces as `setClip.fx` does a clip's. A range export holds part of the mix and is refused. Each call is one undo step.

In the editor, drops, moves and overwrite pastes that remove a whole clip show one short notice naming the replaced clip, with Undo. Media or a paste placed over part of a clip names it as partly replaced in the same notice. A clip moved over part of another, and a trim, stay silent.

### Titles

A title is words on screen with a preset entrance and exit: a lower third, a name, a heading. Add one with a single `insert` command whose `clip.kind` is `"title"`:

```json
{
  "type": "insert",
  "track": 2,
  "at": 180,
  "clip": {
    "kind": "title",
    "text": "Ada Lovelace\nFounder",
    "duration": 150,
    "title": { "position": "lower-left", "plate": "#000000b3" }
  }
}
```

`mode`, `ids` and `clip.id` work as they do for media. A title goes on a video track. `clip.title` takes any of these, and fields left out take the default:

| Field      | Values                                                                                | Default      |
| ---------- | ------------------------------------------------------------------------------------- | ------------ |
| `position` | `lower-left`, `lower-center`, `lower-right`, `center`, `top`                          | `lower-left` |
| `font`     | a family the project declares with `@font-face`, or `null`                            | `null`       |
| `size`     | whole composition pixels, 8 to 2000                                                   | `64`         |
| `weight`   | `400`, `500`, `600`, `700`                                                            | `600`        |
| `color`    | `#rrggbb`                                                                             | `#ffffff`    |
| `align`    | `left`, `center`, `right`                                                             | `left`       |
| `plate`    | `#rrggbbaa` background behind the words, or `null`                                    | `null`       |
| `shadow`   | `{ "color": "#rrggbbaa", "blur": 0 to 200 px }` under the words, or `null`            | `null`       |
| `stroke`   | `{ "color": "#rrggbb", "width": 1 to 100 px }` outline outside the letters, or `null` | `null`       |
| `in`       | `{ "preset": "none" \| "fade" \| "slide" \| "scale" \| "wipe", "frames": n }`         | fade, 0.4 s  |
| `out`      | the same                                                                              | fade, 0.3 s  |

The default size suits 1920x1080; pass a size for other compositions. `font: null` uses the composition's own font. A font no `@font-face` rule in the composition or `index.html` declares is refused with the declared families, because preview and export can resolve a system font to different faces. New projects declare Instrument Sans, Oswald (condensed), Fraunces (serif) and Martian Mono (monospace). Add another with [`fonts_add`](#fonts).

`timeline_read` returns `title` on each title clip and `null` on every other clip. `timeline.fonts` lists the families the project declares, which are the ones `title.font` accepts and the inspector's Font menu offers; it is omitted when the project declares none. Change the look with `setClip.title`, which keeps the fields you leave out, and the words with `setClip.text`:

```json
{
  "type": "setClip",
  "clipId": "title-k7q2xa",
  "title": { "size": 72, "in": { "preset": "slide" } }
}
```

`shadow` and `stroke` are set whole: send both parts, or `null` to remove one. They let white words read over busy footage without a plate, for example `"title": { "stroke": { "color": "#000000", "width": 3 }, "shadow": { "color": "#000000b3", "blur": 12 } }`.

To give several titles one look, the way Copy style and Paste style do in the editor, read the source title's `title` from `timeline_read` and send it whole as `setClip.title` for each of the others in one `timeline_edit` batch, which is one undo step.

`setClip.title` on a clip that is not a title is refused with `unsupported`. `x`, `y`, `opacity`, scale, rotation and crop work as on any visual clip; `x` and `y` offset the title from its `position`, and a Wipe replaces the crop while it runs.

The entrance starts on the clip's first frame and the exit ends on its last. Tail trims, head trims, moves, ripples and pastes keep both there with no further command. When they are longer than the clip together, both shorten in proportion. A ripple through the middle of a title shortens it in place. A razor leaves the entrance on the first piece and the exit on the second, with `preset: "none"` at the cut, so the words run straight through it; set either again with `setClip.title`.

In the source a title is one text element marked `data-cutroom-title`, with each setting in a `data-title-*` attribute, and one `<style data-cutroom-titles>` block per composition that Cutroom writes and keeps current. There is no script and no extra file. A title must contain non-empty plain text, with `<br>` allowed for line breaks, and any named font must have an uncommented `@font-face` declaration in the composition or `index.html`. Invalid content, an undeclared font or an attribute value Cutroom does not write gives `title: null` and a reason in `sourceRestrictions.title`; the element stays on the timeline. Titles work in scene files as well as `index.html`.

### Style

`setClip.style` restyles any visual clip that is not a Cutroom title: an agent-written headline, a shape, an image, a video or a scene. Fields left out keep their values and `null` removes one:

```json
{
  "type": "setClip",
  "clipId": "headline",
  "style": {
    "fontFamily": "Oswald",
    "fontSize": 140,
    "fontWeight": 700,
    "letterSpacing": 0.08,
    "color": "#ffcc00",
    "textTransform": "uppercase",
    "shadow": { "x": 0, "y": 4, "blur": 12, "color": "#000000b3" }
  }
}
```

| Field             | Value                                                     | Written as                                                                        |
| ----------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `fontFamily`      | a family in `timeline.fonts`                              | `font-family: "Oswald", sans-serif`                                               |
| `fontSize`        | composition pixels, 1 to 2000                             | `font-size: 140px`                                                                |
| `fontWeight`      | 100 to 900 in hundreds                                    | `font-weight: 700`                                                                |
| `letterSpacing`   | em, -1 to 2: 0.08 is 8% of the font size                  | `letter-spacing: 0.08em`                                                          |
| `lineHeight`      | multiple of the font size, 0.5 to 5                       | `line-height: 1.1`                                                                |
| `color`           | `#rrggbb` or `#rrggbbaa`                                  | `color: #ffcc00`                                                                  |
| `textAlign`       | `left`, `center`, `right`, `justify`                      | `text-align`                                                                      |
| `textTransform`   | `none`, `uppercase`, `lowercase`, `capitalize`            | `text-transform`                                                                  |
| `fill`            | a colour, or `{from, to, angle}` with colours and degrees | `background: #000000b3` or `background: linear-gradient(90deg, #ff0000, #0000ff)` |
| `borderRadius`    | pixels                                                    | `border-radius: 24px`                                                             |
| `shadow`          | `{x, y, blur, color}`, pixels and a colour                | `filter: drop-shadow(0px 4px 12px #000000b3)`                                     |
| `blur`            | pixels                                                    | `filter: blur(2px)`, after any shadow                                             |
| `width`, `height` | composition pixels                                        | `width: 480px`                                                                    |
| `objectFit`       | `contain`, `cover`, `fill`, `none`, `scale-down`          | `object-fit: cover`                                                               |

Text fields need a text element and `objectFit` a video or image; a clip of another kind, a title (use `setClip.title`) and audio are refused with `unsupported`, and so is a font no `@font-face` in the project declares. Every value is a number, a closed set or a colour pattern, so nothing an agent sends can add markup, an attribute, a `url()` or an expression to the file.

Each field is one declaration in the clip's own `style` attribute, appended after what is there; every other declaration stays byte for byte, and no stylesheet or script is touched. Inline style wins over the composition's stylesheets but not over its animation of the same property, so check with `timeline_view`. `timeline_read` returns `style` on each clip with only the fields set inline in the form above; a value written another way, such as `color: var(--accent)`, is left out and kept until that field is set. Shadow and blur share `filter`, so setting either replaces an inline filter written another way. A Cutroom dip transition animates `filter` while it runs, which hides a clip's shadow and blur for its length.

Preview and export draw the same style. A video or image whose only change is a `contain`, `cover` or `fill` fit keeps the direct FFmpeg export and the footage pipeline; any other style on it sends it to the browser, in preview and export alike.

Paint order stays the track order: a clip on a higher track draws over a lower one. There is no separate z-index, because one would contradict the timeline and turn off the footage pipeline and the direct export for the whole composition. Move a clip to another track to bring it forward or send it back.

### Transitions

A transition sits on a cut between two video, image or audio clips on one track. Set it with `setTransition`, naming the clip that ends at the cut and the one that starts there:

```json
{
  "type": "setTransition",
  "from": "talk-1",
  "to": "talk-2",
  "transition": { "kind": "dissolve", "duration": 30, "alignment": "center" }
}
```

`kind` is `dissolve` (the default) or `dip`, to black and back. `duration` is in frames. `alignment` is `center` (the default), `start`, which begins on the cut, or `end`, which finishes on it. `transition: null` removes it. Linked partners that meet at the same frame get the same transition, so a shot's sound crossfades with its picture; `linked: false` sets only the named cut. Sound always crossfades on equal-power curves, whatever the kind.

Both clips keep their start and length at the cut in `timeline_read`; each carries the transition, as `transitionOut` on the first clip and `transitionIn` on the second. A transition plays the media past each clip's edit point: the outgoing clip needs frames after its out point and the incoming clip frames before its in point, half each for `center`. A length that does not fit is refused with `out_of_bounds`, naming the longest that does and what limits it, such as "Only 13 frames fit at this cut: talk.mp4 has 6 frames of media before its in point." Stills have no limit.

A transition owns the fades on its edges: `setClip.fadeIn` or `fadeOut` there is refused. It stays on its cut through a roll, a razor elsewhere in either clip, and moves and ripples that keep the two clips together. A trim that leaves less room shortens it to fit. Moving either clip away, a trim that opens a gap, or deleting either clip removes it.

In the source each clip's element runs past the cut by its share of the transition, with `data-transition-in` or `data-transition-out` and their `-duration` and `-align` attributes. One `<style data-cutroom-transitions>` block ramps the picture: a dissolve fades the clip later in the document, and marks the other `-under`. Sound plays a generated `data-automation` volume envelope; a clip with its own volume automation keeps it and crossfades with straight `data-fade-in`/`data-fade-out` instead. Preview, `timeline_view` and export play the same attributes through the same runtime.

### Keyframes

Position, Scale, Rotation, Crop and Opacity can each be animated with keyframes on a visual clip. `timeline_read` returns them in `clip.keyframes`: per property, a list of `{ frame, value, ease }` in clip-local frames, where 0 is the clip's first frame, in the same units as the static fields. `keyframes` is `null` on a clip without any. A keyframed property has no static value, so its static fields read `null`:

```json
"keyframes": {
  "opacity": [
    { "frame": 0, "value": 0, "ease": "linear" },
    { "frame": 15, "value": 1, "ease": "linear" }
  ],
  "position": [
    { "frame": 0, "value": { "x": -200, "y": 0 }, "ease": "ease-out" },
    { "frame": 20, "value": { "x": 0, "y": 0 }, "ease": "linear" }
  ]
}
```

Before its first keyframe a property holds the first value, and after its last the last one. `ease` shapes the motion from that keyframe to the next, as CSS does: `linear`, `ease-in` (starts slowly), `ease-out` (ends slowly), `ease-in-out`, or `hold`, which keeps the value until the next keyframe. `position` and `scale` values are `{ x, y }`, `crop` is `{ top, right, bottom, left }`, and `rotation` and `opacity` are numbers.

Three commands edit them, each one undo step in a batch:

```json
{ "type": "setKeyframe", "clipId": "logo", "property": "scale", "frame": 0, "value": { "x": 0.8, "y": 0.8 }, "ease": "ease-out" }
{ "type": "removeKeyframe", "clipId": "logo", "property": "scale", "frame": 0 }
{ "type": "moveKeyframe", "clipId": "logo", "property": "scale", "frame": 0, "to": 12 }
```

`setKeyframe` adds a keyframe or changes the one at that frame. Fields it leaves out of `value`, or the whole `value`, keep what the clip shows at that frame, so `{ "property": "position", "frame": 30, "value": { "x": 80 } }` moves only X. The first keyframe on a property replaces its static value, and `setClip` refuses a keyframed property. `removeKeyframe` takes one away; the last one leaves its value as the static value. `moveKeyframe` retimes one, keeping its value and ease. A new or moved keyframe must lie inside the clip and on a frame without another keyframe of that property.

Keyframing Scale or Rotation on a clip with a static Position keyframes the Position too, at the same frame. The runtime draws a static Position with GSAP, which would fold an animated scale or rotation into the clip's transform once and then draw it twice.

Keyframes stay on the content they animate. Moves and ripples carry them; trimming the head shifts them so each stays on its frame of footage, which can leave keyframes before the clip's first frame or after its last, where they still shape the motion inside the clip. A razor gives each piece the keyframes, so both pieces show what the whole clip showed. A transition draws over them: a dissolve fades from or to whatever the keyframes show.

In the source a keyframed clip carries a `data-cutroom-keyframes` attribute, `"opacity 0 0, 0.5 1; position 0 -200 0 ease-out, 0.666667 0 0"`, with times in seconds from the element's start. One `<style data-cutroom-keyframe-style>` block, which Cutroom rewrites with every edit and removes when no clip has keyframes, turns each attribute value into a CSS animation of the inline longhands `translate`, `scale`, `rotate`, `clip-path` and `opacity`. HyperFrames' CSS adapter seeks it in clip-local time, so preview, `timeline_view` and export draw the same frames, and no script is written. Cutroom titles and transitions run it first in their own animation list, so a title's entrance or a dissolve fades over the keyframed opacity. A clip whose own stylesheet animates it keeps that animation in place of the keyframes. Exports of a composition with keyframes use frame capture.

### Animated titles

For motion the presets do not cover, write the animation yourself as below.

Cutroom never rewrites root animation scripts. Moves can leave their absolute positions behind; new razor pieces and pasted copies also have new IDs that root tweens may not target. Give each animated title its own sub-composition file instead. The HyperFrames runtime places a nested composition's timeline at its host clip's start, so every edit carries the animation with it.

On a fresh project, keep the starter's `<script src="assets/vendor/gsap.min.js"></script>` in `index.html`. New projects carry the pinned GSAP distribution with its license notice, so preview, thumbnails and export work offline. Projects created before Cutroom shipped GSAP, and imported projects, have no local copy, and their titles stay static while `timeline_view` still succeeds. To fix one, copy `node_modules/gsap/dist/gsap.min.js` from the Cutroom install (the pinned build, with its license header) to `assets/vendor/gsap.min.js` in the project, then add `<script src="assets/vendor/gsap.min.js"></script>` to `index.html` before any script that uses GSAP.

First call `source_write` with `path: "compositions/lower.html"`, `expectedVersion: null`, and the second HTML block below as `content`. Then place it with one `timeline_edit` insert, `{ "type": "insert", "track": 2, "at": 180, "clip": { "kind": "composition", "src": "compositions/lower.html", "duration": 180 } }`, which writes the first HTML block for you. Or `source_read` the root, insert the host clip inside its `main` by hand, and save it with that read's exact version. Keep the rest of the starter HTML. Verify the entrance with `timeline_view` at frames 180, 185 and 195 on a 30 fps project, then export the same range.

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

Snapshots are project-scoped and cannot be pasted into another project. Destination timelines must use the same frame rate. Relative media paths are rebased when the destination composition lives in another folder. Copies carry their element markup, including any authored audio group membership. Pasted clips play through the destination's matching bus at its current gain, or at unity when there is no declaration. Styles and scripts belonging to the source composition remain there.

`insert.mode` intentionally defaults to `"place"`, which refuses overlaps. UI Media-panel drops default to overwrite; agents must explicitly pass `mode: "overwrite"` to replace destination frames. `mode: "insert"` splits and shifts unlocked auto-select tracks.

To place part of a file, as Insert and Overwrite do from the source viewer, give the range as `clip.mediaStart` in source seconds and `clip.duration` in timeline frames: `{ "type": "insert", "mode": "overwrite", "track": 0, "at": 240, "clip": { "kind": "video", "src": "assets/interview.mp4", "mediaStart": 2, "duration": 90 } }` places three seconds starting two seconds into the file on a 30 fps timeline. A range that runs past the end of the file is refused with `out_of_bounds`. `source_marks` takes `projectId` and a project-relative media `path` and returns `{ in, out }` in source seconds, with exclusive Out. The response also includes `identity.size` and `identity.duration`; duration is the full file length, or five seconds for a still. Either end is `null` when unmarked; use 0 for an unmarked In and the file duration for an unmarked Out. Pass In as `clip.mediaStart` and convert the range length to timeline frames for `clip.duration`. The tool only reads the owner's saved range; `timeline_edit` already places any explicit range, so there is no separate mark-setting tool.

Source marks persist per project in `.cutroom/view.json`, outside timeline undo history. Each path keeps one entry identified by file size and media duration. Touching, copying or restoring identical media keeps the marks. A changed size or duration starts unmarked; removed files leave one dormant entry and reads return not found. Source-mark saves carry the identity read by the editor; a save for a replaced file is refused with 409. Saves from one editor are serialized per project/file and pending values coalesce across navigation. Superseded reads cannot replace newer choices or cross-tab updates. Network and 5xx save failures retain the latest queued value and retry on the project SSE reconnect or when the file is reopened. An identity conflict drops the rejected value. Valid entries survive malformed neighbours; truncated JSON uses defaults. Source position is not saved; opening a file seeks to its In mark.

Queued view preferences live in the tab's memory. Closing the tab before a value is sent loses it. If two tabs edit the same file's marks simultaneously, request arrival order wins, rather than the time of the latest human action.

Video with sound becomes a muted picture and a linked audio clip. Overwrite routes sound to the overwritten picture's linked audio track, even when a different picture-sound track comes first. A locked partner track or pictures with partners on different audio tracks refuse the edit. With no linked partner under the drop, routing falls back to the first unlocked audio track that holds only linked picture sound and is free over the whole interval, creating one if needed; the fallback never cuts existing audio. Place and insert also require room for the full interval after any ripple. A gap on a music or voice track does not qualify. Silent video and `clip.muted: true` stay video-only. `linkedAudio.id` optionally names the new sound clip. `linkedAudio.track` sends the sound to that audio track instead of routing it: overwrite replaces what is there, insert opens it with the other rippled tracks, and place needs room. A video track is refused with `track_kind`.

`timeline_destinations` takes `projectId` and `composition` and returns `{ video, audio, videoEnabled, audioEnabled }`. The indexes remember the chosen tracks; the booleans say whether Insert, Overwrite and Media menu placement include incoming picture and sound. Omitted enable flags default to true. Pass `video` or `audio` to choose a track, and `videoEnabled` or `audioEnabled` to turn a kind on or off. Turning one off keeps its track. The open editor follows at once. An index of the wrong kind or a missing track is refused with `not_found`. These preferences live in `.cutroom/view.json`, outside undo history.

`timeline_edit` uses explicit commands and never reads these preferences. Respect the returned enable flags when constructing placement: with both on, insert video on `track: <video>` and use `linkedAudio: { track: <audio> }`. With audio off, set the video's `clip.muted: true` and omit `linkedAudio`. With video off and audio on, insert `kind: "audio"` from the same source and marked range on `track: <audio>`. Skip placement when no kind present in the source has an enabled destination.

`setClip.opacity` sets static inline opacity from 0 to 1, canonical to six decimals; `null` removes the inline override. `setTiming` sets `playbackRate` or `mediaStart` in source seconds while keeping timeline duration and linked source sync. Both use the same commands and undo history as the inspector. Timeline reads include `agentChanges`, the clips still underlined for review. `timeline_read` with `clipEdits: true` adds `clipEdits`, the recent owner and agent edit ledger behind it; MCP replies leave it out otherwise, because it grows with every edit. The HTTP timeline route always includes it.

`setClip.x` and `setClip.y` are additive offsets in composition pixels, canonical to six decimals, not absolute canvas coordinates. Positive X moves right and positive Y moves down. Null or zero clears that axis; reads return null when an axis has no offset. `{type:"setClip", clipId:"title", x:null, y:null}` resets both in one undo step. Only the named visual clip moves; linked audio has no position and rejects position edits.

`clip.text` is a text element's words: its text nodes, with `<br>` read as a line break and whitespace collapsed as HTML renders it by default. Inline `white-space: pre-line` preserves source newlines. Multiline text whose whitespace depends on stylesheets or inheritance retains its source newlines and is source-only when the parser cannot establish its cascade. It is null for media and for elements with no text. `setClip.text` replaces those words in the source, HTML-escaped, with each newline written as `<br>`; the whitespace around them stays as authored. One call is one undo step, named "Set text to …" in history, and the editor's inspector uses the same command:

```json
{ "type": "setClip", "clipId": "headline", "text": "Spring\nlaunch" }
```

The edit is refused with `unsupported`, and nothing is written, when the clip's `sourceRestrictions.text` gives a reason: the text has markup inside it (the read still returns the flattened words), it keeps exact spacing or has uncertain multiline whitespace, the element has no closing tag, or a script in the composition writes it by id. That last check finds `textContent`, `innerText`, `innerHTML` and similar writes on the element, directly or through a variable it was read into, and GSAP `text` tweens. A script that reaches the element another way can replace the saved words. The edit still commits. Verify the result with `timeline_view` at relevant frames. In the editor, Text warns at the shown timecode when the selected clip's rendered words differ from the committed text, after settled paint and on later seeks. That warning never blocks editing. Empty text is refused; remove the clip instead.

The pinned HyperFrames 0.9.26 runtime composes `data-x`/`data-y` minus captured `data-hf-edit-base-x`/`data-hf-edit-base-y` with authored CSS position, transforms and GSAP animation. Cutroom captures both existing baselines on the first edit. The runtime reapplies offsets after seeks in preview and render.

`setClip.scale` sets both scale axes and `scaleX` or `scaleY` one, where 1 is the clip's own size, from 0.01 to 100; `rotation` is degrees clockwise; `crop` takes any of `top`, `right`, `bottom` and `left` in pixels of the clip's own box, keeping the edges it leaves out. Both work about the clip's centre. Reads return `scaleX`, `scaleY`, `rotation` and `crop` (all four edges); each is null when unset, and 100%, 0° or a zero crop clears it. `{ "type": "setClip", "clipId": "talk", "scale": 1.1 }` is a 110% punch-in; `{ "type": "setClip", "clipId": "cam", "scale": 0.3, "x": 600, "y": -300, "crop": { "left": 200, "right": 200 } }` is a cropped picture-in-picture. They are written as the inline CSS longhands `scale`, `rotate` and `clip-path: inset()`, which the browser applies after Position's `translate` and before the clip's authored `transform`, so they compose with authored CSS and preview and export draw them the same way. Crop never changes layout. An inline value Cutroom cannot read exactly, such as `var()`, a 3D rotation or a clip-path that is not a pixel inset, is kept through other edits; `sourceRestrictions.transform` says why, and scale, rotation and crop edits on that clip are refused with `unsupported`.

A composition's own animation can override Position, Scale, Rotation and Crop. Commands still save the values. Use `timeline_view` frames to verify the result. In the editor, Transform warns at the displayed timecode when the selected clip's translate differs from the runtime's composed value, or scale, rotation or zoom changes the offset's composition-pixel size; when its computed scale, rotation or clip-path differs from the saved value; or, once GSAP has parsed the clip and folded those values into its own transform, when a GSAP tween that sets scale or rotation has started. The warning names the properties, clears when they hold again and never blocks editing.

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

## Fonts

`fonts_list` returns `declared`, the families `index.html` declares, and `google`: Google Fonts families whose name contains `query`, most popular first, up to `limit` (30 by default), each with its category and the weights it offers from 100 to 900.

`fonts_add` takes `family` exactly as `fonts_list` spells it and `weights`. It downloads one TrueType file per weight into `assets/fonts` and declares each with an `@font-face` rule in the `<style data-cutroom-fonts>` block of `index.html`, as one undo step; undo removes the files too. The family is then in `timeline.fonts`, so `title.font` and `setClip.style.fontFamily` accept it. Preview, `timeline_view` and export load the local files and never fetch a font while rendering. Weights already added are skipped. A family `index.html` declares outside that block is refused with 409. Offline, both tools fail with `Couldn't reach Google Fonts. Check your connection and try again.` and nothing is written. Font files from disk are imported by the owner from the inspector's Font menu.

Cutroom reaches only Google's catalogue (`fonts.google.com/metadata/fonts`), its CSS API (`fonts.googleapis.com/css2`) and font files on `fonts.gstatic.com` whose address has Google's shape; a reply naming any other address fails before it is fetched. Redirects are refused, every reply has a size limit, and each file must be `font/ttf` with a TrueType signature, at most 20 MB. The `@font-face` rules are written from the parsed family, weight and file name, never copied from Google's CSS. Nothing from the project is sent.

## Captions

Captions come from a transcript: transcribe a clip with `transcription_start`, import word timings with `transcript_import`, or import an SRT or WebVTT file with `subtitles_import`. Then one `captions_edit` call adds them:

```json
{
  "projectId": "…",
  "edit": { "action": "generate", "transcriptId": "…", "style": "karaoke" }
}
```

`edit.action` is one of:

| Action      | Fields                                 | Does                                                                                                                                                     |
| ----------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate`  | `transcriptId`, `style?`               | Without captions, writes them and places one Captions clip on a new track. With captions, rewrites them to follow the words where they now play.         |
| `style`     | `transcriptId`, `style`                | `karaoke` (each word lights up as it is spoken), `highlight` (a colour block behind the spoken word) or `plain`. Timing stays.                           |
| `word`      | `transcriptId`, `wordId`, text         | Changes how captions show one word. The transcript keeps its own text, and regenerating keeps the correction.                                            |
| `transform` | `transcriptId`, `wordIds`, `transform` | Sets the selected words’ X and Y offsets in composition pixels, uniform scale and rotation in degrees. Omitted fields stay as saved. Pass null to reset. |

Each call is one undo step and answers with the same view `captions_list` returns: the captions clip id and file, the style, each line in composition seconds, `edits` (corrected words by id), and `stale`. Invalid input is refused before anything is written.

The captions file is `compositions/captions.html` beside the composition (`captions-2.html` and so on when taken): a HyperFrames sub-composition of timed lines, one `<div class="caption-group clip">` per line with a span per word, and one stylesheet. It has no script: the runtime's CSS adapter seeks each word's animation in its line's time, so the viewer, `timeline_view`, frame capture and export draw the same frame. Its host clip carries `data-track-kind="captions"`, which HyperFrames lint and Studio read as the one caption track. Transcript text is written as escaped text, never markup.

Lines break at sentence ends, at pauses of half a second, and at the end of each imported subtitle cue. Longer phrases split into the fewest lines that fit 42 characters (24 on a vertical frame), as even as they can be, preferring a clause end. A line stays up 0.6 s after its last word unless the next line starts sooner; an imported cue keeps its own end. Lines sit at the bottom of the title-safe area, 10% in from each edge, and 28% up on a vertical frame.

Captions stay in step with edits this way:

- Script cuts and restores (`transcript_edit`, or Cut in the Script panel) rewrite the transcript's captions in the same Undo step. Corrections stay with their word IDs. Cutting every word returns an empty cue list until words are restored.
- Other timeline edits to the footage, such as a razor, ripple delete, move or trim, leave the captions as they were, and `captions_list` reports `stale: true`. Call `generate` again. The Script panel shows **Update captions**.
- Regenerating moves the captions clip to hold the lines and rewrites the file, so hand edits to the captions file are replaced. Word corrections, the style, and the clip's look in the inspector stay. A captions file Cutroom cannot read back is refused rather than overwritten; undo the hand edit, or remove the captions clip and generate again.

`captions_export` returns `{ format, filename, text }` for `format` `srt` or `vtt`: one cue per line, in the seconds of the composition the captions play in, clipped to the captions clip if it was trimmed. WebVTT escapes `&`, `<` and `>`.

`subtitles_import` takes the media element as `transcript_import` does, with `format` and the file's `text`. Cue times are seconds into the media file. Each cue's words share its time in proportion to their length, so Script cuts and karaoke work word by word, approximately. Styling tags, voice spans and override blocks are dropped and entities decoded. A file is refused, with the line at fault, when a time is malformed or past 24 hours, a cue ends before it starts, an SRT cue has no number, a WebVTT file lacks its `WEBVTT` header, a cue holds over 2,000 characters, or the file is over 2 MB or 20,000 cues.

## Variables

HyperFrames compositions declare variables in `data-composition-variables` on `<html>` (or a `<template>` file's composition root) and bind them with `data-var-text`, `data-var-src` and `var(--id)` in CSS. Cutroom reads and writes that same declaration and hands overrides to HyperFrames exactly as `hyperframes render --variables` does, so a value previews and exports the same way it renders from the CLI.

Each tool takes `projectId` and `composition` (the root, `index.html`, when omitted).

- `variables_list` returns `declarations` (HyperFrames' own `id`, `type`, `label`, `default`, and `min`, `max`, `maxLength` or `options` where declared) and `preview`, the overrides the editor's viewer shows now.
- `variables_preview` replaces that whole override set with `values`, an object by variable id. Nothing is written to the source or history, and every open editor's viewer reloads the composition with them. `{}` returns to the defaults. Overrides live in the server's memory until it stops; `timeline_view` still renders the defaults.
- `variables_set_default` writes `value` as the declaration's `default`, as one undo step, rewriting only that attribute, and clears its prior preview override. A newer preview from another client stays in place. The save validates the value against the declaration it will write.
- `variables_declare` adds `variable` (`id`, `type`, `label`, `default`, and the type's options) as one undo step. With `bind: { clipId, to }` it also binds the clip's element in the same step: `"text"` sets `data-var-text`, so the variable becomes its words, and `"color"` sets its inline `color: var(--id)`. `"image"` sets `data-var-src` on an image clip. Bindings require a unique authored id on an unlocked track. Text bindings apply to ordinary text elements, and words need one plain line. Give the variable the value the element shows now as its default, so the picture does not change until a value is set.
- `variables_bind` takes `id` and `bind: { clipId, to }` to reuse a declaration in the named `composition` in one undo step. Bind a string variable to words, a color variable to an explicit inline text colour, or an image variable to a single-source image clip. Edit existing word bindings, titles, multiline or nested text, and responsive images in Source. External templates use their own declarations.

Values are untrusted and checked against their declaration before anything previews, renders or is written: strings up to the declaration's `maxLength` and never past 2000 characters, finite numbers inside `min` and `max`, colours as hex only (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), booleans, and enum values from `options`. Undeclared ids are refused. For an image default or override, pass the path to an image in the project, relative to the composition file. Percent-encode characters such as `#` and `?` in filenames. Saving the path as the default preserves an authored image object's other fields. Font variables remain editable in Source. Variable ids are letters, digits, `-` and `_`, so `--id` is always a plain CSS custom property. A value never becomes markup: HyperFrames sets bound words as text, and its CSS binding strips `;{}<>`; the default write escapes the attribute it rewrites.

## Review queue

Each message from Cutroom's agent panel includes a digest of unfinished notes and the project ID. Reconcile the message with that queue before working: withdraw what it cancels, with a reason. For a replacement, add the new request with `review_add`, then withdraw the old note with `replacedBy`. Each Cutroom conversation's native agent reaches these tools through a bridge carrying that conversation's own token (for Codex, set per thread), so the server credits its actions to the running message and stamps withdrawals with it. A token only works on its own project while its run is active; any other use is refused with 409. Every other client, including this server's `/mcp` endpoint and the stdio bridge from Settings, is recorded as an outside agent.

Claim a note before working on it, then complete it with a short note or block it with a question. Claim and complete also accept new notes, so an outside client can work them directly. To claim a blocked note the owner answered in a message, pass that answer; it is saved on the note. `review_complete` reads the latest existing history entry unless you pass a `revision`. It never initializes history; without existing history it records no revision. Claim, complete, block, and release only write `.cutroom/review.json`. A claim lasts for the current Cutroom run, or for the server's lifetime when made by an outside client; unfinished notes then return to the queue. An outside client acts as the owner's delegate: it may also accept, send back, answer, restore, and release notes, and each of those is recorded as an outside agent. Cutroom's own agent may release its claim but cannot accept, send back, answer, or restore its own work. Once sent, a note cannot be edited with `annotation_update` or removed with `annotation_remove`; withdraw it instead. If `history_undo` or `history_redo` removes or changes a sent note's content, the request becomes withdrawn and is credited to you.

MCP mutations use the same server commands as the interface. Edits to project files and note content appear in its undo history; review status lives outside it. File watchers update the visible preview and the Review panel.

`review_reorder` takes `noteId` and `beforeId`. Set `beforeId` to another unfinished note or `null` for the end. This changes the saved owner order used by Review, note numbers, and the next agent digest. Cutroom's own agent cannot reorder; outside clients may act for the owner.

Pass `noteId` to `source_write`, `timeline_edit`, `transcript_edit`, or `captions_edit` when the run has several claimed notes. It must name a note claimed by that run. With one claimed note it is automatic; ambiguous edits are refused before writing, so accepting one note never accepts another note's clips.

## Export

`export_start` takes `projectId` and optional `composition`, `range`, `format`, `quality`, `size`, `fps`, `gpu`, `variables`, `filename`, and `directory`. It uses the editor's render route and job registry over both the stdio bridge and HTTP `/mcp`. The bridge sends the local Origin header; clients do not need to call the render route themselves.

- Omit `composition` to render the root, `index.html`. Name a sub-composition, such as `compositions/intro.html`, to render it alone: its own length, marks, size and rate, with the default name followed by the scene's file name (`Launch intro.mp4`). A sub-composition renders with frame capture.
- Omit `range` to use In to Out when both marks exist, otherwise the whole timeline. `"marks"` requires both marks, `"timeline"` exports everything, and `{ "start": 30, "end": 90 }` exports those half-open project frames. Out is exclusive, as in `timeline_read`.
- `format` is `"mp4"` (H.264 and AAC, the default), `"mov"` (ProRes 4444 with alpha and AAC), `"webm"` (VP9 with alpha and Opus) or `"gif"` (no sound, on-or-off transparency, 30 fps at most). MOV, WebM and GIF are transparent wherever the composition draws nothing, the page background included; for an overlay, hide or remove a full-frame background clip first. `{ "format": "mov" }` on a title is what keys over footage in Resolve.
- `quality` is `"draft"`, `"standard"`, or `"high"`, with Standard as the default, using the dialog's producer presets. It applies to MP4 and WebM.
- `size` is `"project"` (the default), `"1080p"` or `"4k"`, in the composition's orientation. The page is drawn at that size, so a 4K export of a 1080p project has sharp text. A size that isn't the composition's shape, or that would grow it by a fraction, is refused with the reason.
- `fps` is 24, 25, 30 or 60; the composition's own rational rate when omitted. A range keeps its times: `status.range` is in the export's frames, the ones whose times fall inside it, and a range holding no frame at that rate is refused.
- `gifLoop` sets the GIF loop count as a whole number from 0 to 65535. Omit it or use 0 to loop forever.
- `variables` overrides the exported composition's variables by id, as `hyperframes render --variables` does, under the [same checks](#variables) as `variables_preview`. Values equal to a default are dropped. The viewer's preview overrides are not applied unless you pass them here (`variables_list` returns them). An export with overrides renders with frame capture.
- `gpu` defaults to true: an MP4 drawn wholly from its sources encodes with NVENC when the server's probe finds it working. `false` keeps it on libx264.
- Omit `directory` to create the project's `.cutroom/renders` folder on demand. A chosen directory must be an absolute existing folder, under the same path validation as the dialog. App-state folders cannot be redirected through symlinks.
- Omit `filename` to choose the next free project name, then a suffix from 2, in the chosen folder. An explicit filename must end in the format's extension (`.mp4`, `.mov`, `.webm` or `.gif`) and cannot contain folders. An explicit filename that already exists in the folder is refused before the export starts, with the taken path and the next free name. Names are suggestions until publication. A destination taken during rendering fails without replacing it.

Only one export can run at a time across all projects, whether started in the editor or over MCP. A second start is refused with the running export's project, filename, and job ID. Wait for it to finish, or use `export_cancel` with that job ID and wait for cleanup before starting another export.

The response includes `jobId` and `outputPath`. `export_status` takes `jobId` and returns `status`, `stage`, `stageProgress`, `progress` from 0 to 100, `estimate`, `outputPath`, `sizeBytes`, `error`, `format`, `size` (the rendered frame), `fps`, `range` (in the export's frames at `fps`), `encoder` once an export drawn from its sources finishes, and timing/preset details. `estimate` is either null or `{ milliseconds, stage }` for the current stage, using the dialog's measured frame-rate estimator. Preparation, assembly, retries, and stalled progress do not claim an estimate. `sizeBytes` is available once published; `error` preserves the failure cause, including cleanup errors. An export whose browsers make no startup progress for 150 seconds fails with that cause. Completed, failed, and cancelled jobs remain queryable for five minutes after cleanup, while the server remains running.

`export_cancel` takes `jobId` and waits for the worker and its browsers to exit and for partial-output cleanup before returning `cancelled`. An unresponsive worker is stopped after two seconds. Cleanup failure returns an error and leaves the job `failed`. Cancellation after publication keeps the completed file. A native Cutroom agent can start and cancel jobs only for its active run's project. `export_status` is read-only. Start and cancel require separate native approval, including when **Always allow Cutroom edits** is enabled, because exports create output files beyond editable project source.

`export_list` takes `projectId` and returns the project's finished renders, newest first: each `path`, `format`, `sizeBytes` and `modifiedAt` (milliseconds). It lists every export in `.cutroom/renders` and the ones saved to other folders, which Cutroom records in `.cutroom/renders.json` when it publishes them, while the file is still the one it wrote. Agents can't delete renders; the owner deletes them from the Export dialog.

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

## Authored GSAP motion

`motion_read` takes `projectId`, `clipId`, and an HTML `composition` path, defaulting to `index.html`. One source read supplies both `version` and `animations[].id`. Retain both for `motion_update`; IDs include source positions and must never be reused with a different version. After any conflict, read again. External HTML subcompositions use the same template scope as the timeline.

`motion_update` takes those same fields, `expectedVersion`, `animationId`, and one `change`:

```json
{ "kind": "property", "side": "to", "name": "x", "value": 320 }
```

Use `side: "from"` for a `from` tween's properties or a `fromTo` tween's starting properties. Timing changes are `{"kind":"position","value":0.5}` and `{"kind":"duration","value":2}` in seconds. Easing is `{"kind":"ease","value":"power2.out"}`. Only fields already authored as literals are writable. The response is a fresh snapshot. Every other source byte stays unchanged, and each update is one shared Undo step with normal actor attribution and project permission checks.

`targets` lists every element affected by the selector, so a shared selector edits all of them. Locked target tracks refuse the edit. `reason`, `notices`, and `sourceOnly` explain limits. This slice accepts direct `to`, `from`, `fromTo`, and `set` calls on one top-level named timeline, plus literal standalone `gsap.set`. Computed fields, helper/loop construction, indirect vars, aliases, ambiguous timelines, keyframes, motion paths, standalone `gsap.to/from/fromTo`, and external JavaScript stay in source. There is no add, delete, unroll, or conversion operation. Inherited or implicit timing and easing are not materialized.
