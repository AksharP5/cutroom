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

L and J double the speed on each press, up to 8x; the other direction drops back to 1x, and Shift starts at 4x. Marks are undoable timeline edits that agents see through MCP. Out is inclusive on screen and exclusive in the engine's range.

Timeline zoom keys hold the playhead still when it is on screen, and the middle of the view otherwise. Shift+V selects the clips under the playhead on unlocked tracks with auto-select on.

In the timeline, Ctrl+wheel, Alt+wheel, and a trackpad pinch zoom at the cursor, Shift+wheel scrolls through time, and the wheel scrolls tracks. Ctrl-click adds or removes a clip, Shift-click selects through to it, Alt-click leaves linked clips out, and dragging from an empty lane draws a marquee.
