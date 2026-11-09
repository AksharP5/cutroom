# Editing behavior

Canvas and timeline controls come from the pinned public HyperFrames editor. Cutroom adds review notes and word-based edits to the same project history.

## Review

Drawings and comments carry a composition path, frame time, selected element, normalized geometry, and note text. Frame captures are saved under `.cutroom/attachments/`; the metadata remains in `cutroom.json` so undo restores the note. Captured frames can be reopened from the notebook and are attached when pending notes are sent to an agent.

Resolving, deleting, and sending notes preserve their other fields. Pending text stays in place when switching notebook tabs or hiding panels. Agent drafts also survive project switches and reloads.

## Script

Word times refer to original media. The displayed timeline time is derived from the current media source, including cuts and moved clips.

A direct cut removes the selected words' source intervals, splits the media element into kept pieces, and ripples subsequent clips on that lane. Other lanes keep their timing. Restoring words rebuilds the kept intervals. Both HTML and script metadata change in one history window.

Direct script edits currently require a local, independently timed media element. Nested timed scenes, linked media, independently changed split pieces, and media-specific scripted animation are refused rather than rewritten ambiguously. Use the agent handoff for those edits.

## Concurrent edits and undo

Editor writes, script changes, annotations, and MCP commands share a history. A save based on an older source version returns a conflict instead of overwriting a newer edit. External agents can also edit files directly; the watcher refreshes the preview and the history observes those changes.

Undo can conflict with a newer outside edit. Resolve that conflict before applying another change. Original video and audio files remain intact.
