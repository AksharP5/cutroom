# Editing behavior

Canvas and timeline controls come from the pinned public HyperFrames editor. Cutroom adds review notes and word-based edits to the same project history.

## New editor

Settings has a New editor switch, off by default. It replaces the embedded editor's centre with Cutroom's own tool row, viewer, transport, and a timeline below a draggable split. The timeline shows and selects clips; editing them, the inspector, file panels, and export are not there yet, so switch back for those.

The viewer fits the composition inside the stage with a 12px margin, on whole pixels. Fit and 100% are in the zoom menu. Draw and Comment work as in the embedded editor, and the picture outline turns yellow while one is armed.

The transport follows DaVinci Resolve: L and J play, faster on each press up to 8x; K stops; arrows step frames, seconds, and edits. [Every key](keyboard.md). Timecode is `HH:MM:SS:FF` at the nominal rate, without drop frames. Click it to type a time: digits fill from the right, Enter seeks, and Esc cancels. Playback at 1x is audible, and Mute silences it. Faster speeds and reverse step through frames silently.

I and O set the timeline's in and out points through the same `setRange` command MCP clients use, so each mark is one undo step and agents see it. With loop on, playback repeats the range, or the whole timeline when no range is set.

When anything the preview uses changes on disk (HTML, CSS, scripts, or media), whether from an agent, an MCP edit, or another editor, the viewer keeps showing its last frame while the new version loads, then shows the new version at the same frame. If the new version does not load, the last frame stays and the status bar says why.

### Timeline

The timeline reads the same projection MCP clients get from `timeline_read`, so an agent's edit or an undo shows up as soon as the file changes. Video tracks stack upward from the divider and audio tracks downward; each header has the track's id and name, a lock, and auto-select, both saved through `setTrack` as undoable edits. Clips on a locked track dim and cannot be selected.

The ruler is the scrub surface: press or drag it to move the playhead. Its step is the smallest of 1, 2, 5 and 10 frames, 1, 2, 5, 10 and 30 seconds, and 1, 5, 10, 30 and 60 minutes that keeps labels 96px apart. The in and out points show as brackets with a lighter band between them and a line down through the tracks. Markers sit on the ruler's lower edge with their names; a name shortens, then hides, rather than run under the next marker or bracket. Clicking a marker moves the playhead there. A timecode label disappears when it reaches the track headers, so a scrolled ruler never shows a cut-off time. Review notes sit on its upper edge as dots: yellow while a note waits on the agent, hatched blue while the agent works on it, solid blue when the work is ready to review, and a hollow ring once accepted. Clicking a dot moves the playhead to the note and shows it in Review.

A clip's name stays at the left edge of the view while any of the clip is on screen. Names show on clips at least 28px wide and durations at 200px.

Video and image clips show a filmstrip: 40px tiles from the clip's first frame, so a trimmed or retimed clip shows what it plays. Zoomed in until a tile covers less than two seconds of source, each tile shows an exact frame: the first is the clip's first frame, and the rest step on from it in even steps (1 s, 0.5 s, down to a sixteenth), each the last step at or before the tile's left edge. Those frames are fetched one by one, and the nearest earlier sprite frame stands in until each arrives. Zoomed out further, every tile shows a frame from a sprite that holds one every two seconds, so a tile can show footage up to two seconds before its left edge. Audio clips show a min/max waveform, and a video clip that plays sound carries a 12px strip of it along the bottom of its filmstrip. A muted video, or one whose file has no audio stream, shows no strip. Bodies stay flat colour until the media cache answers, and for compositions and other elements.

Zoom runs from the whole timeline to 32px per frame. The slider in the ruler's corner is logarithmic; double-click it to fit. Zooming with the wheel or a pinch follows the input and holds the frame under the cursor still. The buttons, the slider's track, and the keys ease to the new zoom around the playhead. During playback the view pages when the playhead reaches 90% of the width. [Keys and gestures](keyboard.md).

## Review

Drawings and comments carry a composition path, frame time, selected element, normalized geometry, and note text. Frame captures are saved under `.cutroom/attachments/`; the note content remains in `cutroom.json` so undo restores it. Captured frames can be reopened from the notebook and are attached when new notes are sent to an agent. Clicking a note opens its composition before seeking to its frame.

A stroke or a comment click opens the note and puts the cursor in its text, so typing never reaches the editor's shortcuts. Marking again before saving replaces the mark and keeps the words already typed; only closing the note clears them.

Each note stays in the queue until an explicit step finishes it:

| Status            | Meaning                               | Next                                                          |
| ----------------- | ------------------------------------- | ------------------------------------------------------------- |
| New               | Saved, not yet sent                   | Sending any message queues it. Only new notes can be deleted. |
| Queued            | Waiting for the agent                 | The agent claims, completes, blocks, or withdraws it.         |
| Working           | Claimed by the running agent          | Returns to Queued when the run ends, or when you return it.   |
| Needs your answer | The agent asked a question            | Answer in Review, or in chat; the agent saves a chat answer.  |
| Done              | The agent finished, with a short note | Accept it, or send it back to Queued with what to change.     |
| Withdrawn         | Cancelled, with the reason and actor  | Restore returns it to Queued.                                 |
| Accepted          | You approved the result               | Final.                                                        |

You can withdraw any unfinished note; once sent, a note can only be withdrawn, so its reason is always recorded. The agent can withdraw a queued, working, blocked, or done note when your message asks for it. Accept, send back, answer, restore, and return to queue are yours; an outside MCP client can also do them for you, recorded as an outside agent, but Cutroom's own agent cannot judge its own work. Your answers and send-back notes stay on the note through every later status and are repeated to the agent.

Once sent, a note's text and position no longer change; withdraw it and add a new note instead. Status and your added instructions live in `.cutroom/review.json`, outside undo history, together with a copy of each sent note. That copy is the request. If undo, redo, restore, or an edit outside Cutroom removes a sent note or changes its content, the request stays visible as sent and becomes withdrawn with a reason such as "Removed by undo" or "Changed outside Cutroom", credited to whoever did it. Bringing the content back leaves the request withdrawn, so you decide whether to restore it; restoring needs the content to match what was sent. Cutroom checks for these changes, and saves the result, whenever Review is read and around every undo, redo, and restore.

If `.cutroom/review.json` becomes unreadable, Review shows the error, and statuses stop changing and undo, redo, and restore are blocked until it is repaired, so no sent request is lost; transcripts and chat keep working. An unreadable `cutroom.json` does not block undo, because undo is how it gets repaired. Edits an agent makes to `cutroom.json` directly, rather than through Cutroom's tools, are credited to an outside agent. Notes from earlier versions keep their meaning: sent notes become Queued and resolved notes become Accepted. Their old status fields stay in `cutroom.json` but are ignored once the note has an entry in `review.json`.

Editing a note's text preserves its other fields. Pending text stays in place when switching notebook tabs or hiding panels. Agent drafts also survive project switches and reloads. Review frames and transcription controls stay with their owning project; returning to a running transcription resumes its status updates.

## Script

Word times refer to original media. The displayed timeline time is derived from the current media source, including cuts and moved clips.

A direct cut removes the selected words' source intervals, splits the media element into kept pieces, and ripples subsequent clips on that lane. Other lanes keep their timing. Restoring words rebuilds the kept intervals. Both HTML and script metadata change in one history window.

Direct script edits currently require a local, independently timed media element. Nested timed scenes, linked media, independently changed split pieces, and media-specific scripted animation are refused rather than rewritten ambiguously. Use the agent handoff for those edits.

## Timeline commands

The timeline is a projection of composition HTML in integer frames: a clip starts on the first frame the runtime shows it, and ends after the last. Tracks are `data-track-index` values. Track kind (video or audio), name, lock, and auto-select, plus markers and the in/out range, live in `cutroom.json`; a track keeps its kind when it is empty. Audio clips go on audio tracks and everything else on video tracks; a move, insert, or kind change that breaks this fails with `track_kind`. Commands follow DaVinci Resolve's Edit page:

- Linked clips (`data-link`) are one unit: they move, split, and delete together, and a trim moves the same edge of every partner by the same number of frames, as with Resolve's Linked Selection. J and L cuts keep their offset.
- Lift (`remove`) leaves a gap. Ripple delete removes the union of the selected clips' time ranges, including linked partners, on the edited tracks and every unlocked auto-select track. Choosing the union for uneven linked selections is Cutroom's policy, not a claim about Resolve. Deleting a J-cut pair can therefore also trim the preceding shot where its picture overlaps the selected audio head. Overlapping ranges close once; separate ranges close from right to left without deleting the time between them. A J-cut head or L-cut tail under a deleted clip loses the overlapping time, so later material closes the full gap.
- A shortening `trim` with `ripple` keeps the clip's start and removes the trimmed time from the other participating tracks. Q removes `[old start, playhead)`; W removes `[playhead, old end)`. Linked partners trim their own corresponding edge by the same number of frames, preserving J/L offsets. Their tracks use that partner's removed range; other tracks use the named clip's range. An extending ripple trim cuts other clips at the old edge and opens exactly the added time there, leaving their source offsets intact.
- Removing `[from, to)` is an explicit cut, never a clamp. Clips ending at or before `from` stay unchanged. Clips starting at or after `to` move left by `to - from`. Clips wholly inside disappear. A clip ending inside keeps its head up to `from`; one starting inside keeps its tail from `to`, moved to `from`, with its source offset advanced. A spanning clip becomes two adjacent pieces at `from`, with the right piece's source offset advanced to its original frame at `to`. Playback rate applies to every source offset adjustment. A single surviving head or tail keeps its id, including references from scripts and styles. Only a clip spanning the entire range needs a copied right piece with a deterministic numbered id.
- Locked tracks never change. An auto-select-off track still ripples when it contains an explicitly edited clip or its linked partner; other auto-select-off tracks stay whole. A protected clip may remain linked to a shortened partner when their surviving shared frames retain the same source alignment. For example, a protected picture `[0,100)` stays unchanged while its audio tail `[0,120)` shortens to `[0,100)` after deleting B-roll `[100,150)`. If a protected clip would change or lose sync with surviving partner content, the entire edit fails with `unsupported`, naming that clip. Directly editing an unlinked locked clip still fails with `locked`. Source limits, clip lengths and overlaps must pass exactly; a ripple never reduces the requested edit to make it fit.
- A cut keeps a piece linked while it still overlaps a partner in time; a piece left with no overlapping partner is unlinked.
- `split` without clip IDs cuts every clip under the frame on auto-select tracks. Right halves of a linked group share a new link.
- A clip id names one clip for the life of the project, across undo and redo. Every id a project has used is listed in `.cutroom/ids.json`, outside undo history, and no new clip takes one of them. `split`, `insert`, and ripple `trim` and `remove` take `ids`: for each clip they cut, a list of names for its new pieces in the order the command cuts them (a ripple through several ranges cuts a spanning clip more than once). A name that is in the timeline or in that list is refused with `duplicate_id`. Pieces without a name, inserted media without `clip.id`, and script cuts get the source id or file name plus four random letters or digits (`talk-k7q2`, `talk-cut-m2x9`).
- `insert` places a clip, overwrites the range on its own track (linked partners on other tracks stay whole), or splits and pushes auto-select tracks. An inserted video is written with `data-has-audio` from its file: `true` when ffprobe finds an audio stream, `false` when it finds none. Each clip in the projection carries `hasAudio`: audio clips, and video that is not `muted` and not marked `data-has-audio="false"`.

These cuts follow Resolve's sync-preserving Edit-page ripple model introduced in [DaVinci Resolve 20.2, New Features Guide, pages 7-8](https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_20.2_New_Features_Guide.pdf#page=7). Earlier Resolve versions mainly moved clips starting after the edit, leaving spanning music or titles uncut. Resolve 20.2 also added independent Sync Lock controls, explained on page 12. Cutroom currently uses auto-select for ripple participation and refuses linked edits across excluded tracks; it does not expose Resolve's separate Sync Lock toggle or its preference to restore the older ripple behavior.

The [Resolve 21 Reference Manual](https://documents.blackmagicdesign.com/UserManuals/DaVinci_Resolve_21_Reference_Manual.pdf) describes ripple delete in "Deleting Clips From the Timeline", page 933, the shared ripple rules and cuts in "Ripple Editing Rules", page 1100 and "Sync Lock Controls" on page 1101, and the playhead trim commands in "Trim Start and Trim End" and "Resize, Ripple, and Roll Start and End Commands", pages 1115-1117. Q and W are the owner's bindings, not Resolve's factory shortcuts. The interval cases above make the documented before/after sync rule deterministic for Cutroom; the manuals do not enumerate each partial-overlap case or document a linked smallest-gap exception.

A command that cannot apply exactly fails with a typed error such as `overlap`, `locked`, or `out_of_bounds`; values are never clamped. Moved clips may not overlap another clip on their track, although overlaps already authored in HTML stay editable. Video and audio without `data-duration` take their length from the source file, measured with ffprobe; trims cannot run past the end of the source. A start written as a clip reference (`data-start="intro"`) is kept while it still resolves to the edited position and becomes an absolute time otherwise. Clips styled or animated by id, or containing elements with ids, cannot be split because the copy would lose or duplicate them. The root's length keeps its authored tail after the last clip; a root kept shorter than its content does not grow, and clips placed in an empty composition only lengthen it if they run past its end.

A batch writes only the attributes it changes, removed elements, and new clips; all other bytes stay as authored. Clips without an `id` get their positional id written when an edit touches them or would renumber them. It is one undo step, and a stale revision is refused.

## Concurrent edits and undo

Editor writes, script changes, annotations, and MCP commands share a history. A save based on an older source version returns a conflict instead of overwriting a newer edit. External agents can also edit files directly; the watcher refreshes the preview and the history observes those changes. Accepted outside changes update a clean source buffer even while it has focus. Pending typing keeps the normal save and conflict handling.

Undo can conflict with a newer outside edit. Resolve that conflict before applying another change. Original video and audio files remain intact.
