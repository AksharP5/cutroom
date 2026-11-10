# Editing behavior

Canvas and timeline controls come from the pinned public HyperFrames editor. Cutroom adds review notes and word-based edits to the same project history.

## New editor

Settings has a New editor switch, off by default. It replaces the embedded editor's centre with Cutroom's own tool row, viewer, and transport, with room for a timeline below a draggable split. The timeline, inspector, file panels, and export are not there yet; switch back for those.

The viewer fits the composition inside the stage with a 12px margin, on whole pixels. Fit and 100% are in the zoom menu. Draw and Comment work as in the embedded editor, and the picture outline turns yellow while one is armed.

The transport follows DaVinci Resolve: L and J play, faster on each press up to 8x; K stops; arrows step frames, seconds, and edits. [Every key](keyboard.md). Timecode is `HH:MM:SS:FF` at the nominal rate, without drop frames. Click it to type a time: digits fill from the right, Enter seeks, and Esc cancels. Playback at 1x is audible, and Mute silences it. Faster speeds and reverse step through frames silently.

I and O set the timeline's in and out points through the same `setRange` command MCP clients use, so each mark is one undo step and agents see it. With loop on, playback repeats the range, or the whole timeline when no range is set.

When the composition changes on disk, from an agent, an MCP edit, or another editor, the viewer keeps showing its last frame while the new version loads, then shows the new version at the same frame. If the new version does not load, the last frame stays and the status bar says why.

## Review

Drawings and comments carry a composition path, frame time, selected element, normalized geometry, and note text. Frame captures are saved under `.cutroom/attachments/`; the note content remains in `cutroom.json` so undo restores it. Captured frames can be reopened from the notebook and are attached when new notes are sent to an agent. Clicking a note opens its composition before seeking to its frame.

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
- Lift (`remove`) leaves a gap. Ripple delete closes it on the removed clips' tracks and every auto-select track. Clips later than the gap move earlier by the removed time (on tracks with nothing removed, the time removed from every track); a clip that spans the gap stays.
- `trim` with `ripple` keeps the clip's start and shifts clips at or after the trimmed edge by the change in length. Q trims the start to the playhead, so everything from the clip's head onward moves; W trims the end, moving what follows it.
- A ripple moves each linked group by one amount. Ripple delete closes a group by the smallest gap among its members' tracks, and no clip passes the one before it, so sync holds and a few frames of gap may remain on one track. That leftover gap is the only thing a ripple delete holds back: if a clip would stay put because a spanning clip, a partner on a locked or unreached track, or the start of the timeline is in its way, the edit fails with `unsupported`, naming the clip in the way. A trim or insert that would pull a partner before zero or into another clip is refused with `unsupported`, naming the linked clips.
- A cut keeps a piece linked while it still overlaps a partner in time; a piece left with no overlapping partner is unlinked.
- `split` without clip IDs cuts every clip under the frame on auto-select tracks. Right halves of a linked group share a new link.
- `insert` places a clip, overwrites the range on its own track (linked partners on other tracks stay whole), or splits and pushes auto-select tracks.
- Locked tracks never change. Ripple edits skip them, and editing a clip on one fails.

A command that cannot apply exactly fails with a typed error such as `overlap`, `locked`, or `out_of_bounds`; values are never clamped. Moved clips may not overlap another clip on their track, although overlaps already authored in HTML stay editable. Video and audio without `data-duration` take their length from the source file, measured with ffprobe; trims cannot run past the end of the source. A start written as a clip reference (`data-start="intro"`) is kept while it still resolves to the edited position and becomes an absolute time otherwise. Clips styled or animated by id, or containing elements with ids, cannot be split because the copy would lose or duplicate them. The root's length keeps its authored tail after the last clip; a root kept shorter than its content does not grow, and clips placed in an empty composition only lengthen it if they run past its end.

A batch writes only the attributes it changes, removed elements, and new clips; all other bytes stay as authored. Clips without an `id` get their positional id written when an edit touches them or would renumber them. It is one undo step, and a stale revision is refused.

## Concurrent edits and undo

Editor writes, script changes, annotations, and MCP commands share a history. A save based on an older source version returns a conflict instead of overwriting a newer edit. External agents can also edit files directly; the watcher refreshes the preview and the history observes those changes. Accepted outside changes update a clean source buffer even while it has focus. Pending typing keeps the normal save and conflict handling.

Undo can conflict with a newer outside edit. Resolve that conflict before applying another change. Original video and audio files remain intact.
