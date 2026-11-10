# Keyboard

The new editor (Settings, New editor) uses DaVinci Resolve's Edit page keys, and each action keeps its Resolve action id. Shortcuts never fire while you type in a field or work in a dialog. Esc returns to Select.

| Action                         | Keys              | Action id                         |
| ------------------------------ | ----------------- | --------------------------------- |
| Select                         | `A`               | `editPointer`                     |
| Draw                           | `Shift+N`         | `cutroomDraw`                     |
| Comment                        | `N`               | `cutroomComment`                  |
| Play or stop                   | `Space`           | `controlPlayToggle`               |
| Play forward, faster on repeat | `L`, `4`          | `controlPlayForward`              |
| Play reverse, faster on repeat | `J`, `3`          | `controlPlayReverse`              |
| Play forward at 4x             | `Shift+L`         | `controlFastForward`              |
| Play reverse at 4x             | `Shift+J`         | `controlFastReverse`              |
| Stop                           | `K`               | `controlStop`                     |
| Previous frame                 | `Left`            | `controlStepReverse`              |
| Next frame                     | `Right`           | `controlStepForward`              |
| Back one second                | `Shift+Left`      | `controlLargeStepReverse`         |
| Forward one second             | `Shift+Right`     | `controlLargeStepForward`         |
| Previous edit                  | `Up`              | `controlClipPrev`                 |
| Next edit                      | `Down`            | `controlClipNext`                 |
| Timeline start                 | `Home`            | `controlTimelineStart`            |
| Timeline end                   | `End`             | `controlTimelineEnd`              |
| First frame                    | `;`               | `controlFirstFrame`               |
| Last frame                     | `'`               | `controlLastFrame`                |
| Mark in                        | `I`               | `markIn`                          |
| Mark out                       | `O`               | `markOut`                         |
| Clear in                       | `Alt+I`           | `markResetIn`                     |
| Clear out                      | `Alt+O`           | `markResetOut`                    |
| Clear in and out               | `Alt+X`           | `markResetInOut`                  |
| Go to in                       | `Shift+I`         | `controlGotoIn`                   |
| Go to out                      | `Shift+O`         | `controlGotoOut`                  |
| Loop                           | `Ctrl+/`          | `controlLoop`                     |
| Undo                           | `Ctrl+Z`, `` ` `` | `editUndo`                        |
| Redo                           | `Ctrl+Shift+Z`    | `editRedo`                        |
| Fullscreen viewer              | `P`               | `workspaceViewerModeCinemaViewer` |

L and J double the speed on each press, up to 8x; the other direction drops back to 1x, and Shift starts at 4x. Marks are undoable timeline edits that agents see through MCP. Out is inclusive on screen and exclusive in the engine's range.
