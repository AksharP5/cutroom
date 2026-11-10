# Keyboard

The new editor (Settings, New editor) uses DaVinci Resolve's Edit page keys, and each action keeps its Resolve action id. Shortcuts never fire while you type in a field or work in a dialog. Esc returns to Select.

| Action                                       | Keys                     | Action id                         |
| -------------------------------------------- | ------------------------ | --------------------------------- |
| Select                                       | `A`                      | `editPointer`                     |
| Draw                                         | `Shift+N`                | `cutroomDraw`                     |
| Comment                                      | `N`                      | `cutroomComment`                  |
| Play or stop                                 | `Space`                  | `controlPlayToggle`               |
| Play forward, faster on repeat               | `L`, `4`                 | `controlPlayForward`              |
| Play reverse, faster on repeat               | `J`, `3`                 | `controlPlayReverse`              |
| Play forward at 4x                           | `Shift+L`                | `controlFastForward`              |
| Play reverse at 4x                           | `Shift+J`                | `controlFastReverse`              |
| Stop                                         | `K`                      | `controlStop`                     |
| Previous frame                               | `Left`                   | `controlStepReverse`              |
| Next frame                                   | `Right`                  | `controlStepForward`              |
| Back one second                              | `Shift+Left`             | `controlLargeStepReverse`         |
| Forward one second                           | `Shift+Right`            | `controlLargeStepForward`         |
| Previous edit                                | `Up`                     | `controlClipPrev`                 |
| Next edit                                    | `Down`                   | `controlClipNext`                 |
| Timeline start                               | `Home`                   | `controlTimelineStart`            |
| Timeline end                                 | `End`                    | `controlTimelineEnd`              |
| First frame                                  | `;`                      | `controlFirstFrame`               |
| Last frame                                   | `'`                      | `controlLastFrame`                |
| Mark in                                      | `I`                      | `markIn`                          |
| Mark out                                     | `O`                      | `markOut`                         |
| Clear in                                     | `Alt+I`                  | `markResetIn`                     |
| Clear out                                    | `Alt+O`                  | `markResetOut`                    |
| Clear in and out                             | `Alt+X`                  | `markResetInOut`                  |
| Go to in                                     | `Shift+I`                | `controlGotoIn`                   |
| Go to out                                    | `Shift+O`                | `controlGotoOut`                  |
| Loop                                         | `Ctrl+/`                 | `controlLoop`                     |
| Undo                                         | `Ctrl+Z`, `` ` ``        | `editUndo`                        |
| Redo                                         | `Ctrl+Shift+Z`           | `editRedo`                        |
| Fullscreen viewer                            | `P`, `Ctrl+F`            | `workspaceViewerModeCinemaViewer` |
| Fit the timeline, or return to the last zoom | `Shift+Z`                | `viewZoomSubZoomToFit`            |
| Zoom the timeline in                         | `Ctrl+=`, `Ctrl+Shift+=` | `viewZoomSubZoomIn`               |
| Zoom the timeline out                        | `Ctrl+-`                 | `viewZoomSubZoomOut`              |
| Select clips at the playhead                 | `Shift+V`                | `editSelectItemAtPlayhead`        |
| Deselect all                                 | `Shift+A`, `Esc`         | `editDeselectAll`                 |
| Ripple trim the start to the playhead        | `Q`                      | `trimRippleStartToPlayhead`       |
| Ripple trim the end to the playhead          | `W`                      | `trimRippleEndToPlayhead`         |
| Razor at the playhead                        | `E`                      | `editBladeRazor`                  |
| Split at the playhead                        | `Ctrl+\`                 | `editM2SplitClip`                 |
| Lift, leaving a gap                          | `X`, `Backspace`         | `editBackspace`                   |
| Ripple delete                                | `Shift+X`, `Delete`      | `editDelete`                      |
| Turn clips on or off                         | `D`                      | `editClipEnabled`                 |
| Add a marker                                 | `M`                      | `markMarkerAdd`                   |

While a note is open on the picture, its text takes every key: Enter adds it, Shift+Enter starts a new line, Esc discards it, and Ctrl+Z undoes text typed since the last stroke before taking back strokes. Ctrl+Shift+Z restores strokes and undone text. Ruler clicks return focus to the note.

L and J double the speed on each press, up to 8x; the other direction drops back to 1x, and Shift starts at 4x. Marks are undoable timeline edits that agents see through MCP. Out is inclusive on screen and exclusive in the engine's range.

Timeline zoom keys hold the playhead still when it is on screen, and the middle of the view otherwise. Shift+V selects the clips under the playhead on unlocked tracks with auto-select on.

Q, W, E and Ctrl+\ act on the selected clips under the playhead. When no selected clip is under it, they act on the clips under it on unlocked tracks with auto-select on. Q and W ripple trim one clip and its linked partners: the first of those clips from V1 up, then audio. Every other auto-select track loses the same stretch of time, as in Resolve 20.2 and later: a title or music bed spanning the cut is cut too, so sync holds. Turn auto-select off on a track to leave it alone. The playhead stays where it is after Q and W; Resolve's manual does not say whether it moves. E and Ctrl+\ both razor. X and Backspace lift the selection and leave a gap; Shift+X and Delete ripple delete it. D turns the selected clips off or back on. A clip that is off stays on the timeline, grey and dimmed, and preview and export leave it out. M adds a marker at the playhead.

Each press is one undo step. The timeline shows the edit as soon as you press the key, and the clips it moves slide to their new place. A key acts on what was on screen when it was pressed: the same clips, never others an agent's edit moved under the playhead since. If an agent changed those clips first, the edit is taken back and the header says "An agent changed those clips first. Press it again." A key that leaves an agent's clips alone, such as M after an agent's marker, still lands. If the engine refuses an edit in the editor, the header says why, naming tracks, times, and clips as the timeline shows them. The next edit that lands clears the message.

In the timeline, Ctrl+wheel, Alt+wheel, and a trackpad pinch zoom at the cursor, Shift+wheel scrolls through time, and the wheel scrolls tracks. Ctrl-click adds or removes a clip, Shift-click selects through to it, Alt-click leaves linked clips out, and dragging from an empty lane draws a marquee.
