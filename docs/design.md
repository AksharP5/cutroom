# Design system

Cutroom is a cutting bench in graphite and paper.
Its surfaces have zero chroma so footage supplies the colour, with clip-kind colours kept on the timeline.
Two pencils mark the work. Yellow is yours, for your marks, messages, and the caret, while blue marks agent work in progress or awaiting review.
Red belongs to the playhead and to errors, and flat panels meet at 1px seams without cards, pills, panel shadows, or decorative gradients.
Selection is paper with bracket ends, and numbers are mono and tabular, with quiet leading zeros in timecode.
The interface shows state first, so default controls stay quiet and secondary actions can appear on approach.

## Where values live

[Tokens](../src/client/tokens.css) are the source of truth for colour, type, space, size, radius, stroke, layer, and motion.
Read the tokens in component CSS and in code that draws UI. Keep fixed colours, sizes, durations, and z-index values out of components.
[Shared styles](../src/client/styles.css) import the tokens, map them to the embedded editor's theme, and define the common controls.
[Menu styles](../src/client/components/select-menu.css), [editor styles](../src/client/edit/edit.css), [inspector styles](../src/client/edit/inspector/inspector.css), and [timeline styles](../src/client/timeline/timeline.css) cover their own areas.

Use the `@custom-media` aliases in CSS. [Vite](../vite.config.ts) expands them with Lightning CSS.
Media queries cannot read custom properties, so script uses the mirrored `--breakpoint-*` properties where it needs the same threshold.
Update both declarations together in `tokens.css`.

| CSS alias  | Script threshold                         | What changes                                            |
| ---------- | ---------------------------------------- | ------------------------------------------------------- |
| `--drawer` | `--breakpoint-drawer`, below 1304px wide | Inspector becomes a drawer and starts closed.           |
| `--rail`   | `--breakpoint-rail`, below 1024px wide   | The embedded workspace uses its compact tool treatment. |
| `--short`  | `--breakpoint-short`, below 960px tall   | Media shows six rows and Timing starts collapsed.       |

Reuse the closest token first. If a new value is needed, extend the nearest scale with a name that describes its role and can be reused.
Measure WCAG contrast for each new foreground and background pair, including interactive overlays where they apply, and record the ratios in the token comment. Keep one-off values out of the scale.

## Colour

Cutroom is dark only by design. All seven surface tokens are neutral.

| Surface                                  | Use                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `--surface-ground`                       | App ground, panel seams, and the stage around the picture.                               |
| `--surface-lane`, `--surface-lane-video` | Audio and video lanes, respectively. The audio tone also backs the read-only curve well. |
| `--surface-panel`                        | Panels, header, and status bar.                                                          |
| `--surface-raised`                       | Fields, composer, and dialog.                                                            |
| `--surface-float`                        | Menus, popovers, and toasts.                                                             |
| `--surface-active`                       | Static backing for armed tools and active segments.                                      |

Use `--line-subtle` for hairlines within a panel, `--line` for field borders and dividers, `--line-strong` for major ruler ticks, and `--line-lane` between timeline lanes.
Set a readable foreground directly. Never fade a row to make its contents secondary. The timeline dims locked lane content and desaturates and dims disabled clips to show that they are inactive.

The contrast ratios below are the measurements recorded in `tokens.css`. Hover and press are measured over the panel.

| Foreground         | Use                                | Panel | Raised | Float | Hover | Press |
| ------------------ | ---------------------------------- | ----: | -----: | ----: | ----: | ----: |
| `--text-primary`   | Labels, body, and current values   |  16.0 |   15.0 |  14.6 |  13.4 |  12.1 |
| `--text-secondary` | Supporting text and quiet controls |   7.9 |    7.4 |   7.2 |   6.6 |   5.9 |
| `--text-tertiary`  | Hints and low-priority metadata    |   6.0 |    5.7 |   5.5 |   5.1 |  4.55 |
| `--text-quiet`     | Quiet timecode groups only         |   3.5 |        |       |       |       |

Reserve `--glyph-faint` for non-text marks such as idle diamonds and hollow accepted pins.

| Signal        | Meaning and use                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--human`     | Yellow marks human input, including notes, the message rule, and the caret. Use `--on-human` for ink on yellow.                         |
| `--agent`     | Blue marks active or unaccepted agent work, including the presence square and changed-clip underline. Use `--on-agent` for ink on blue. |
| `--playhead`  | Red for the playhead and the meter's clipping indication.                                                                               |
| `--danger`    | Red for errors and destructive actions, including missing media.                                                                        |
| `--selection` | Paper for selection, brackets, in/out, and armed tools. Use `--on-selection` and `--on-selection-meta` for text and metadata on paper.  |
| `--accepted`  | Neutral tertiary tone. Accepted notes use hollow pins and struck text, and accepted edits lose the blue underline.                      |

Clip-kind colour belongs to timeline media. Video, image, composition, audio, and voiceover use the `--clip-*` rail, head, and body families.
The 2px rail identifies the kind, the tinted head carries the name and duration, and the body stays flat. Waveforms use the quieter `--wave-*` tones.
Keep clip colours out of action, selection, and status cues.

Marker flags and names use grey, green, violet, rose, or sand. Keep those colours for markers, and reserve the human yellow, agent blue, and error or playhead reds for their own signals.
In the code editor, use `--code-keyword`, `--code-name`, `--code-attribute`, `--code-string`, and `--code-number` for syntax. Keep that palette in the source editor.

## Type

Instrument Sans is the reading face. Martian Mono keeps changing digits aligned. Use `.mono` for numbers and `<kbd>` for shortcuts. Both use tabular numbers and `--stretch-mono` at 87.5%.
Clip, track, and media names use `--stretch-condensed` at 87% to leave room for controls.
Use regular 400 for body, medium 500 for controls and values, semibold 600 for titles and tabs, and bold 700 for emphasis.

| Token                |  Size | Use                                                                      |
| -------------------- | ----: | ------------------------------------------------------------------------ |
| `--type-micro`       |   9px | Meter scale and transition lengths.                                      |
| `--type-field-tight` | 9.5px | Timecode in paired inspector fields.                                     |
| `--type-2xs`         |  10px | Ruler labels, marker names, clip names, track IDs, and small timecodes.  |
| `--type-xs`          |  11px | Metadata, durations, and status.                                         |
| `--type-sm`          |  12px | Body, controls, and panel titles. Use `--leading-body` at 16px for body. |
| `--type-md`          |  13px | Chat. Use `--leading-chat` at 19px.                                      |
| `--type-clock`       |  17px | Current time in the transport.                                           |

Display timeline timecode as `HH:MM:SS:FF`. Put [TimecodeText](../src/client/components/TimecodeText.tsx) inside a mono parent for readouts.
It keeps the whole value in the text and quiets leading zero groups. Use its `trailing` option where the ruler recesses a zero frames group.
The selection styles provide `--on-selection-quiet` for those zeros on paper.

Use [Phosphor](../src/client/main.tsx) through `@phosphor-icons/react`. Regular is the default. Toggles such as the editor tools and loop switch to Fill to show state without spending a signal colour.
The icon sizes are `--icon-xs` 10px, `--icon-sm` 12px, `--icon-md` 14px, and `--icon-lg` 16px.

## Space, shape, and layers

Use the 4px spacing unit and its `--space-*` scale. Match shared row heights so edges line up across panels.

| Element                               | Token and size                                                        |
| ------------------------------------- | --------------------------------------------------------------------- |
| Header and workspace tabs             | `--size-header` 40px, `--size-tab-row` 36px                           |
| Panel head and inspector section head | `--size-panel-head` 34px, `--size-section-head` 30px                  |
| Standard, media, and ledger rows      | `--size-row` 28px, `--size-media-row` 30px, `--size-ledger-row` 24px  |
| Inspector row and field               | `--size-inspector-row` 26px, `--size-field` 22px                      |
| Tool row, transport, and status       | `--size-tool-row` 32px, `--size-transport` 40px, `--size-status` 24px |

Use `--radius-clip` 2px for clips, `--radius-control` 4px for controls and fields, `--radius-float` 6px for floating UI, and `--radius-modal` 8px for dialogs.
Hairlines, selection outlines, and the playhead stem use 1px. Bracket ends, clip rails, agent and tab underlines, and the human message rule use 2px.
Drawing on the picture uses `--stroke-pencil` 3px on `--stroke-pencil-casing` 7px so the mark reads over footage.

From back to front, the layer tokens are clip 1, selected clip 2, range lines 3, playhead 4, track heads 5, popover 20, toast 30, scrim 40, and modal 41.
Use the existing layer by role. Shared menus and dialogs use the browser's top layer via popover and dialog, respectively.

## Motion

Motion confirms an action or shows a completed edit. Animate transform and opacity only. Use shorter exits than entrances.
Selection, tool arming, and keyboard feedback are instant. A keyboard edit can still show what moved after it lands.
Avoid spinners, pulses, shimmer, and skeleton sweeps. Agent presence uses a static mark and elapsed clock. A working review pin can use `--agent-hatch` in a small layer with no text on the hatch.

| Feedback                      | Duration tokens                                                                           | Easing                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Selection and arming          | `--duration-instant` 0ms                                                                  | None                                                      |
| Hover and press               | `--duration-hover` 120ms, `--duration-press` 90ms                                         | `--ease-fade` for hover, `--ease-out` for press           |
| Panel and menu entry and exit | `--duration-panel-in` 200ms, `--duration-panel-out` 120ms                                 | `--ease-out` in, `--ease-exit` out                        |
| Tab indicator                 | `--duration-indicator` 220ms                                                              | `--ease-out`                                              |
| Edit landing and ripple       | `--duration-edit` 220ms                                                                   | `--ease-in-out` for things already on screen              |
| Zoom and paging               | `--duration-zoom` 200ms, `--duration-page` 180ms                                          | `--ease-out`. Wheel and pinch zoom follow input directly. |
| Short fades and note overlays | `--duration-fade` 160ms, `--duration-note-fade` 200ms                                     | `--ease-fade` for generic opacity changes                 |
| Toast entry, exit, and hold   | `--duration-toast-in` 220ms, `--duration-toast-out` 140ms, `--duration-toast-hold` 4000ms | `--ease-out` in, `--ease-exit` out                        |
| Dialog entry                  | `--duration-modal-in` 240ms                                                               | `--ease-out`                                              |

Under `prefers-reduced-motion`, the tokens remove entry offsets and scale changes, zero the edit, indicator, zoom, page, and strike durations, and shorten panel, toast, and dialog entrances to 100ms.
Follow that policy for new controls. Remove translation and scaling and keep any remaining fade short.

## Components

Start with the shared classes in `styles.css`. Use the component when it owns behaviour such as keyboard navigation or focus restoration.

| Building block          | Class or component                                                                                       | Use for                                                                                                                  | Avoid for                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Icon button             | `.icon-button`                                                                                           | Compact, familiar action or toggle with an accessible name.                                                              | Actions that need a visible verb.                                        |
| Text button             | `.text-button`, `.text-button.quiet`                                                                     | Inline actions such as a row decision.                                                                                   | The main confirmation in a dialog.                                       |
| Secondary button        | `.secondary-button`                                                                                      | Bordered alternate action, such as Cancel.                                                                               | Every action in a dense list.                                            |
| Primary button          | `.primary-button`                                                                                        | Main action or confirmation, with a paper fill and a specific verb.                                                      | Default tool toggles or a row of equal options.                          |
| Field                   | `input`, `textarea`, `.field-label`, `.inspector-field`                                                  | Labelled text entry or an inspector value. Use `.composer` for chat.                                                     | Display-only metadata.                                                   |
| Select menu             | [SelectMenu.tsx](../src/client/components/SelectMenu.tsx), `.select-trigger`                             | Choosing one value from a labelled listbox.                                                                              | A list of commands.                                                      |
| Context menu            | [ContextMenu.tsx](../src/client/components/ContextMenu.tsx), [menu.ts](../src/client/components/menu.ts) | Commands for the target under the pointer or keyboard. Use a keymap action for a shared label and shortcut.              | A value field or a required step hidden behind right-click.              |
| Dialog                  | [Modal.tsx](../src/client/components/Modal.tsx), `.modal-actions`                                        | Focused forms and confirmations. Give it a title and choose initial focus where needed. It restores focus to its opener. | Status updates and ordinary inline edits.                                |
| Toast                   | `.toast-slot`, `.toast` in [App.tsx](../src/client/App.tsx)                                              | Brief feedback in the header centre. Errors stay until dismissed.                                                        | Persistent status or errors that belong beside a field.                  |
| Tabs                    | `.workspace-tabs`, `.tab-indicator`                                                                      | Peer work panels; the paper indicator follows the current label.                                                         | Actions and independent toggles.                                         |
| Panel and section heads | `.panel-header`, `.inspector-section summary`                                                            | A panel title or a collapsible group of related fields.                                                                  | Decorative headings above a label that already names the group.          |
| Rows                    | `.media-row`, `.review-row`, `.file-row`                                                                 | Repeated items. Review actions appear on hover or focus within.                                                          | A stack of cards or a row whose only action is inaccessible by keyboard. |
| Empty state             | [EmptyState.tsx](../src/client/components/EmptyState.tsx), `.small-empty`                                | First-run project actions, or compact in-panel guidance when there is a next step.                                       | A placeholder for every empty list.                                      |
| Timecode                | [TimecodeText.tsx](../src/client/components/TimecodeText.tsx), `.mono`                                   | A frame time with quiet zeros.                                                                                           | Counts and other values that are not timecodes.                          |
| Tooltip                 | [ToolButtons.tsx](../src/client/edit/ToolButtons.tsx), native `title`                                    | Tool name and shortcut, or supplementary detail such as an untruncated path. Give the trigger its own accessible name.   | Essential instructions available only on hover.                          |
| Scrollbar               | Shared scrollbar rules in `styles.css`                                                                   | Use the 8px scrollbar, transparent track, and neutral thumb tokens.                                                      | A separate scroll treatment for one panel.                               |

Define the states below before shipping a control. Mark states that do not apply.

| State             | What to define                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rest              | Readable label, quiet default, and the normal action.                                                                                                                           |
| Hover             | Reveal secondary actions on approach and on focus within. Shared controls fade a `--overlay-hover` pseudo-element, a 7% white layer, through opacity.                           |
| Press             | Reuse the shared button treatment. It scales to `--press-scale` at 0.96 while pressed.                                                                                          |
| Focus-visible     | Use the paper `--focus-ring-color`, `--focus-ring-width` 2px, and `--focus-ring-offset` 1px. Keep it visible inside scroll areas. Fields can show the outline on their wrapper. |
| Selected or armed | Show the state immediately with paper, a static active backing, or a filled icon as appropriate. Expose the state to assistive technology.                                      |
| Editing           | Show what will change and how to commit or cancel. Scope input shortcuts to the field or dialog.                                                                                |
| Disabled          | Prevent activation and show the disabled state. Explain a blocker where the next action depends on it.                                                                          |
| Busy              | Use a static mark, progress text or elapsed time, and a stop action when available.                                                                                             |
| Error             | Show a readable error beside its source, with a way to act or dismiss it.                                                                                                       |
| Empty             | Give a useful next step when one exists. Leave an obvious empty list quiet.                                                                                                     |

## Copy and performance

Use plain words and sentence case. Say what happened and what to do next. Errors name the thing that failed and the fix, with the raw message available on demand.
Skip eyebrows, subheads that repeat a heading, helper text that repeats a label, and empty states that explain the obvious.
Use mono for numbers and shortcuts. Keep em dashes and emojis out of UI copy.

Follow the [keyboard rules](keyboard.md) for focus, menus, and shortcuts.
Keep streaming updates scoped to the changed content and keep layout reads and writes out of the streaming and scrubbing paths.
Avoid perpetual motion and continuously repainting effects. Use the relevant [performance gates](performance.md) before and after the change, with the same project, viewport, and action.

## Before you open a UI PR

- [ ] All fixed design values come from tokens.
- [ ] Applicable states are defined and reachable, with visible keyboard focus.
- [ ] Reduced motion removes movement.
- [ ] Contrast is measured for any new foreground and background pair.
- [ ] Before and after screenshots use the same viewport and scenario.
- [ ] The relevant performance gate ran for changes to the timeline, viewer, or a hot list.
