# Timeline headers

Matched screenshots of the same generated video project, freshly captured from main at 1284735 and from the updated timeline header branch. Both keep the 132 px header column. Compact captures include video, audio, and an armed microphone at 28, 32, 36, and 39 px track heights.

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

Compact rows show short track codes and every toggle with 18 px targets. The full track name stays in the code tooltip and accessible group label. The inline input meter is hidden only in Compact; Normal and Tall retain the name row, meter, and separate 20 px control row. Density uses the app's shared keyboard-operated SelectMenu.
