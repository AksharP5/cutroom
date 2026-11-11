# Keyboard

The editor uses DaVinci Resolve's Edit page keys, and each action keeps its Resolve action id. Shortcuts never fire while you type in a field or work in a dialog. Esc returns to Select. During voiceover recording, Ctrl+Alt+Shift+V, Space and K stop and save, and Esc stops and asks before discarding the take, including when a field has focus. Cancelling saves it.

| Action                                       | Keys                     | Action id                          |
| -------------------------------------------- | ------------------------ | ---------------------------------- |
| Export                                       | `Shift+8`                | `workspacePrimaryWorkspaceDeliver` |
| Select                                       | `A`                      | `editPointer`                      |
| Trim                                         | `T`                      | `editTrim`                         |
| Blade                                        | `B`                      | `editBlade`                        |
| Draw                                         | `Shift+N`                | `cutroomDraw`                      |
| Comment                                      | `N`                      | `cutroomComment`                   |
| Play or stop                                 | `Space`                  | `controlPlayToggle`                |
| Record or stop voiceover                     | `Ctrl+Alt+Shift+V`       | `cutroomRecordVoiceover`           |
| Play forward, faster on repeat               | `L`, `4`                 | `controlPlayForward`               |
| Play reverse, faster on repeat               | `J`, `3`                 | `controlPlayReverse`               |
| Play forward at 4x                           | `Shift+L`                | `controlFastForward`               |
| Play reverse at 4x                           | `Shift+J`                | `controlFastReverse`               |
| Stop                                         | `K`                      | `controlStop`                      |
| Previous frame                               | `Left`                   | `controlStepReverse`               |
| Next frame                                   | `Right`                  | `controlStepForward`               |
| Back one second                              | `Shift+Left`             | `controlLargeStepReverse`          |
| Forward one second                           | `Shift+Right`            | `controlLargeStepForward`          |
| Previous edit                                | `Up`                     | `controlClipPrev`                  |
| Next edit                                    | `Down`                   | `controlClipNext`                  |
| Timeline start                               | `Home`                   | `controlTimelineStart`             |
| Timeline end                                 | `End`                    | `controlTimelineEnd`               |
| First frame                                  | `;`                      | `controlFirstFrame`                |
| Last frame                                   | `'`                      | `controlLastFrame`                 |
| Mark in                                      | `I`                      | `markIn`                           |
| Mark out                                     | `O`                      | `markOut`                          |
| Clear in                                     | `Alt+I`                  | `markResetIn`                      |
| Clear out                                    | `Alt+O`                  | `markResetOut`                     |
| Clear in and out                             | `Alt+X`                  | `markResetInOut`                   |
| Go to in                                     | `Shift+I`                | `controlGotoIn`                    |
| Go to out                                    | `Shift+O`                | `controlGotoOut`                   |
| Loop                                         | `Ctrl+/`                 | `controlLoop`                      |
| Copy clips                                   | `Ctrl+C`                 | `editCopy`                         |
| Cut clips, leaving a gap                     | `Ctrl+X`                 | `editCut`                          |
| Paste clips                                  | `Ctrl+V`                 | `editPaste`                        |
| Paste insert                                 | `Ctrl+Shift+V`           | `editPasteInsert`                  |
| Undo                                         | `Ctrl+Z`, `` ` ``        | `editUndo`                         |
| Redo                                         | `Ctrl+Shift+Z`           | `editRedo`                         |
| Fullscreen viewer                            | `P`, `Ctrl+F`            | `workspaceViewerModeCinemaViewer`  |
| Fit the timeline, or return to the last zoom | `Shift+Z`                | `viewZoomSubZoomToFit`             |
| Zoom the timeline in                         | `Ctrl+=`, `Ctrl+Shift+=` | `viewZoomSubZoomIn`                |
| Zoom the timeline out                        | `Ctrl+-`                 | `viewZoomSubZoomOut`               |
| Select clips at the playhead                 | `Shift+V`                | `editSelectItemAtPlayhead`         |
| Deselect all                                 | `Shift+A`, `Esc`         | `editDeselectAll`                  |
| Ripple trim the start to the playhead        | `Q`                      | `trimRippleStartToPlayhead`        |
| Ripple trim the end to the playhead          | `W`                      | `trimRippleEndToPlayhead`          |
| Razor at the playhead                        | `E`                      | `editBladeRazor`                   |
| Split at the playhead                        | `Ctrl+\`                 | `editM2SplitClip`                  |
| Lift, leaving a gap                          | `X`, `Backspace`         | `editBackspace`                    |
| Ripple delete                                | `Shift+X`, `Delete`      | `editDelete`                       |
| Turn clips on or off                         | `D`                      | `editClipEnabled`                  |
| Add a marker                                 | `M`                      | `markMarkerAdd`                    |
| Snapping                                     | `C`                      | `editSnapping`                     |

Ctrl+Alt+Shift+V is unused in the owner's Resolve preset and avoids the older KDE Klipper shortcut Ctrl+Alt+V. Its only recording-related action, `viewTimelineModeRecord`, has no assigned key. Shift+R remains reserved for Resolve's Freeze Frame.

While a note is open on the picture, its text takes every key: Enter adds it, Shift+Enter starts a new line, Esc discards it, and Ctrl+Z undoes text typed since the last stroke by word or after a one-second pause before taking back strokes. Ctrl+Shift+Z restores strokes and undone text. Ruler clicks return focus to the note.

L and J double the speed on each press, up to 8x; the other direction drops back to 1x, and Shift starts at 4x. Marks are undoable timeline edits that agents see through MCP. Out is inclusive on screen and exclusive in the engine's range.

Timeline zoom keys hold the playhead still when it is on screen, and the middle of the view otherwise. Shift+V selects the clips under the playhead on unlocked tracks with auto-select on.

Q, W, E and Ctrl+\ act on the selected clips under the playhead. When no selected clip is under it, they act on the clips under it on unlocked tracks with auto-select on. Q and W ripple trim one clip and its linked partners: the first of those clips from V1 up, then audio. Every other auto-select track loses the same stretch of time, as in Resolve 20.2 and later: a title or music bed spanning the cut is cut too, so sync holds. Turn auto-select off on a track to leave it alone. Q parks the playhead at the clip's new start, showing the first surviving frame. W keeps it at the cut, showing the following clip. A refused trim leaves the playhead at its original frame unless you have sought elsewhere while it was pending. E and Ctrl+\ both razor. X and Backspace lift the selection and leave a gap; Shift+X and Delete ripple delete it. D turns the selected clips off or back on. A clip that is off stays on the timeline, grey and dimmed, and preview and export leave it out. M adds a marker at the playhead.

Each press is one undo step. The timeline shows the edit as soon as you press the key, and the clips it moves slide to their new place. A key acts on what was on screen when it was pressed: the same clips, never others an agent's edit moved under the playhead since. If an agent changed those clips first, the edit is taken back and the header says "An agent changed those clips first. Press it again." A key that leaves an agent's clips alone, such as M after an agent's marker, still lands. If the engine refuses an edit in the editor, the header says why, naming tracks, times, and clips as the timeline shows them. The next edit that lands clears the message.

In the timeline, Ctrl+wheel, Alt+wheel, and a trackpad pinch zoom at the cursor, Shift+wheel scrolls through time, and the wheel scrolls tracks. Ctrl-click adds or removes a clip, Shift-click selects through to it, Alt-click leaves linked clips out, and dragging from an empty lane draws a marquee.

On home, the arrow keys, Home, and End move between projects, and Enter opens the selected one. The most recently edited project is selected when home opens.

## Mouse

On an audio track, the R button arms the microphone. Only one track is armed. The microphone icon chooses an input, remembered on this machine, and the armed header shows its input level. The red Record button in the transport or Ctrl+Alt+Shift+V starts playback and recording at the playhead. The armed R stays lit, a Recording mark appears by the timecode, and a take region grows along the armed lane. Recording stops at the end of the cut or after 30 minutes. Loop is temporarily off. A take uses empty space on the armed track; an overlap goes on a new audio track so previous audio stays intact. One undo removes the take and any track it created. The WAV file stays in `assets/voiceover/` for another take or an agent to use. A dropped microphone block leaves silence at its original position, keeps the rest of the take in sync, and reports the dropped duration. A failed save opens the microphone panel with Retry save, Download take, and a confirmed Discard take. Switching projects or editors is blocked until the take is saved or discarded. Closing or reloading warns before leaving an unsaved take.

A, T and B choose what a press on a clip does, as on Resolve's Edit page. A, T, B and C are the owner's Resolve bindings for `editPointer`, `editTrim`, `editBlade` and `editSnapping`.

- **Select (A).** Drag a clip's body to move it, along its track or to another. Drag an edge to resize it; nothing else moves.
- **Trim (T).** Drag an edge to ripple trim it. On a cut between two clips, drag to roll the cut. A press on a clip's body selects it.
- **Blade (B).** Click a clip to razor it at that frame.

A press becomes a drag after 3px. Esc cancels a drag and changes nothing else: the tool and the selection stay. Each drag is one undo step. Linked clips move together; hold Alt at the press to move one alone. Dragging to another track carries the clips of the grabbed clip's kind, and their linked partners follow in time on their own tracks. A move onto another clip overwrites the frames it covers. The preview trims or splits the covered clips and hides fully covered clips, including on linked partners' tracks. Locked tracks and picture onto an audio track still refuse the move. A resized or rolled edge stops at its neighbour and at the end of its source. Resolve's Ctrl+Shift drag on Windows/Linux, or Cmd+Shift on macOS, is a shuffle/swap insert, documented on pages 969-970 of the [Resolve 21 manual](https://documents.blackmagicdesign.com/UserManuals/DaVinci_Resolve_21_Reference_Manual.pdf#page=969). Cutroom does not yet implement shuffle moves.

With snapping on, a dragged edge within 8px of a clip edge, the playhead, a marker, or in or out jumps to it, and a line marks where. C turns snapping off or on, also in the middle of a drag, as Resolve's snapping key does. Holding Ctrl while dragging turns it off until the key is let go; that hold is Cutroom's, not Resolve's.

Drag a file from Media onto a track to add it, with its first frame under the pointer. A normal drop overwrites only the covered frames on the destination track. Hold Ctrl+Shift on Windows/Linux or Cmd+Shift on macOS while dropping to insert and open auto-select tracks. Video with sound also overwrites the same range on its linked picture-sound track; music and voice tracks stay in place. Drag picture above the top video track to create a video track, or audio below the last audio track to create an audio track. Existing clips use those same edge bands when moved. An incompatible edge refuses the drop and explains why in the header. Track creation and the drop undo together. Picture is refused on audio tracks and audio on video tracks. A still runs five seconds.

Media-drop overwrite and insert modifiers follow the [Resolve 21.1 manual, pages 891-893](https://documents.blackmagicdesign.com/UserManuals/DaVinci_Resolve_21.1_Reference_Manual.pdf#page=891). The owner's Resolve 21.1.2 preset has Insert and Overwrite actions, with no separate mouse-modifier binding. Ctrl/Cmd still bypasses snapping, including during an insert drop.

Shift+8 opens Export, matching `workspacePrimaryWorkspaceDeliver` in the owner's Resolve preset. It has no video-render binding; Ctrl+E exports a Resolve project. When both In and Out exist, Export defaults to that range. Closing the dialog keeps its job running; the Export indicator opens it again.

Drag a clip's volume envelope vertically to change gain, with the line following the pointer and a dB readout. Hold Alt for one-tenth travel for fine adjustment. A mostly horizontal drag that starts on the envelope moves the clip. Alt at the press still moves a clip without its linked partners. The owner's Resolve preset contains no fine-gain mouse binding. Alt fine adjustment is Cutroom's mouse convention.

A cut inside a fade leaves the rest of that fade as volume automation on the piece. Select the clip and use Inspector > Audio > Clear automation to remove it before drawing a fresh fade. Clearing undoes in one step.

Ctrl+C copies the selected clips with their linked partners. Ctrl+X copies and lifts them, leaving a gap. Ctrl+V pastes at the playhead on their source tracks, overwriting only the copied intervals. Ctrl+Shift+V is Paste Insert: it opens the whole copied span once, including gaps, and ripples unlocked auto-select tracks with the same link and source-cut rules as media insert. The earliest copied start lands on the playhead; relative timing, J/L cuts, clip properties, and source offsets stay intact. Each cut or paste is one undo step; copy adds no history. Copied clips get fresh ids and their own links.

The in-app clipboard survives selection changes and timeline switches within the same project during the server session. It keeps the copied source even after a cut or later source edit. Timelines must use the same frame rate. Other projects have separate clipboards; pasting between projects is unsupported. Copy refuses source-restricted clips by name, as an explicit razor does. Paste Insert refuses a spanning restricted clip with the existing auto-select hint. The preset's Alt+V is Paste Attributes, which remains unsupported; it is not Paste Insert.
