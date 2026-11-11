# Ripple feedback

Design checkpoint 5, item 10. Matching captures from the production builds of `origin/main` at `65dbdf0` and `ripple-feedback`, using installed Chromium 155 at 1720×1050 and DPR 1, with audio muted. Both use the same synthetic composition and a timeline resized to start at y=360. Source media and private projects are absent.

| Scenario | Before | After |
| --- | --- | --- |
| Q at 00:00:27:17 | ![Silent six-track ripple](before-ripple.png) | ![Removed 27:17 from 6 tracks, five clips deleted, Undo](after-ripple.png) |
| Four outside agent moves affecting three distinct clips | ![Moves without a notice](before-agent.png) | ![Agent moved 3 clips](after-agent.png) |
| Title text at normal height | ![Title names alone](before-titles-normal.png) | ![First-line title previews](after-titles-normal.png) |
| Compact density with V1 at its 28 px minimum | ![Compact names alone](before-titles-compact.png) | ![Text fits inside the compact title](after-titles-compact.png) |

The Q case trims the 30-second Project title, removes the five short titles on other tracks, and shifts End title left. One toast reports that result. Clicking its Undo restores all seven clips in one step. Simple same-track Q stays silent. Ripple delete, insert drops and Paste Insert use the same reporting path.

Agent moves use the commands endpoint with `x-cutroom-agent: external`, the same endpoint used by MCP. The notice counts distinct changed clips rather than requests. Focus remains in the chat field. The browser check also verifies that the notice expires. Disk-written text changes refresh the title preview and produce an outside-edit notice.

The first title's second authored line is visible in the viewer and absent from the timeline preview. The two-second titles ellipsize within their clip bounds. The text uses the existing 10 px clip-label scale and colour. It is extracted from the existing parse tree, with no parsing during playback.
