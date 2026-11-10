# Editing behavior

Canvas and timeline controls come from the pinned public HyperFrames editor. Cutroom adds review notes and word-based edits to the same project history.

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

If `.cutroom/review.json` becomes unreadable, Review shows the error and statuses stop changing until it is repaired; transcripts and chat keep working. Notes from earlier versions keep their meaning: sent notes become Queued and resolved notes become Accepted. Their old status fields stay in `cutroom.json` but are ignored once the note has an entry in `review.json`.

Editing a note's text preserves its other fields. Pending text stays in place when switching notebook tabs or hiding panels. Agent drafts also survive project switches and reloads. Review frames and transcription controls stay with their owning project; returning to a running transcription resumes its status updates.

## Script

Word times refer to original media. The displayed timeline time is derived from the current media source, including cuts and moved clips.

A direct cut removes the selected words' source intervals, splits the media element into kept pieces, and ripples subsequent clips on that lane. Other lanes keep their timing. Restoring words rebuilds the kept intervals. Both HTML and script metadata change in one history window.

Direct script edits currently require a local, independently timed media element. Nested timed scenes, linked media, independently changed split pieces, and media-specific scripted animation are refused rather than rewritten ambiguously. Use the agent handoff for those edits.

## Concurrent edits and undo

Editor writes, script changes, annotations, and MCP commands share a history. A save based on an older source version returns a conflict instead of overwriting a newer edit. External agents can also edit files directly; the watcher refreshes the preview and the history observes those changes. Accepted outside changes update a clean source buffer even while it has focus. Pending typing keeps the normal save and conflict handling.

Undo can conflict with a newer outside edit. Resolve that conflict before applying another change. Original video and audio files remain intact.
