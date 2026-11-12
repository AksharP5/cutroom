# Keep empty tracks

Design checkpoint 6, issue 2. Matching captures use the production build, Chromium, a 1720 × 1050 viewport, the starter project and a generated 12-second interview video. No user media is included.

- `before-lifts.png` and `after-lifts.png`: lift the rule and getting-started caption, then reload. Before, the surviving title is relabelled V1. After, all three video tracks remain.
- `before-interview-drop.png` and `after-interview-drop.png`: drop the interview at frame zero on the row labelled V1. Before, the title disappears. After, the interview lands on the empty first track and the title keeps its original row. The current starter puts the title on V2.
- `before-overwrite.png` and `after-overwrite.png`: deliberately overwrite two whole title clips. The fixed editor names them once and offers Undo.
- `after-paste.png`: overwrite-paste a copied title onto a shorter title. The notice names the replaced title and Undo restores it.

Before is origin/main at 1d782a652c672b9fbd2fa458a1949cd4fc128af4. The browser regressions fail there because the title is gone and overwrite notices are missing. The fixed browser tests use the notice's Undo and compare the entire resulting timeline with its state before the edit. They also remove an empty track through its header menu and undo that removal with the saved name and height intact.
