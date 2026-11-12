# Timeline headers

Matched screenshots of the same generated video project, before and after the timeline header fixes. Compact captures include video, audio, and an armed microphone with its live input meter. Track heights are 28, 32, 36, and 39 px.

| Scenario | Before | After |
| --- | --- | --- |
| Compact, 1280×800, DPR 1 | [Before](before-compact-1280x800-dpr1.png) | [After](after-compact-1280x800-dpr1.png) |
| Compact, 1280×800, DPR 2 | [Before](before-compact-1280x800-dpr2.png) | [After](after-compact-1280x800-dpr2.png) |
| Compact, 1720×1050, DPR 1 | [Before](before-compact-1720x1050-dpr1.png) | [After](after-compact-1720x1050-dpr1.png) |
| Compact, 1720×1050, DPR 2 | [Before](before-compact-1720x1050-dpr2.png) | [After](after-compact-1720x1050-dpr2.png) |
| Density menu, 1280×800 | [Before](before-density-1280x800-dpr1.png) | [After](after-density-1280x800-dpr1.png) |
| Density menu, 1720×1050 | [Before](before-density-1720x1050-dpr1.png) | [After](after-density-1720x1050-dpr1.png) |
| Media drag held, 1280×800 | [Before](before-drag-held-1280x800-dpr1.png) | [After](after-drag-held-1280x800-dpr1.png) |
| Media drag held, 1720×1050 | [Before](before-drag-held-1720x1050-dpr1.png) | [After](after-drag-held-1720x1050-dpr1.png) |

Resting screenshots accompany each drag capture. The first video lane starts at y=467 at 1280×800 and y=717 at 1720×1050. Before the fix, starting a media drag moves it down 57 px. After the fix, every lane keeps its resting position. The new video target overlays the ruler's bottom edge and previews the full track at its eventual position.

The header column grows from 132 to 224 px so compact rows can retain the name, 20 px buttons, microphone, and input meter on one line. Density uses the app's shared keyboard-operated SelectMenu.
