# Cutroom

A local video studio with native coding agents, visual review, and script editing.

![Cutroom editor](docs/editor.png)

- Edit compositions on the canvas and timeline, with source files and shared undo history.
- Draw on a frame, pin timed comments, and send a batch of notes to your agent.
- Transcribe local footage, select words, and cut or restore them without changing the original media.
- Run installed Codex or Claude Code with their own skills, models, configuration, and sessions.
- Let outside agents work on the same projects over MCP.
- Export video locally. No Cutroom account is required.

## Run

The [Linux release](https://github.com/AksharP5/cutroom/releases) includes Bun and Node.js. Extract it and run `./install.sh` to add Cutroom to your application launcher. Run `./cutroom` directly to use the portable folder.

### From source

Requires Bun 1.4.4 or newer, Node.js 22.18 or newer, FFmpeg, and a Chromium-compatible browser. Agent chat additionally requires an installed and authenticated Codex or Claude Code. Whisper transcription is optional.

```sh
bun install
bun run build
bun run desktop
```

For the browser interface:

```sh
bun start
```

Open `http://127.0.0.1:4317`. `bun run dev` starts the development interface on port 5173.

## Projects and agents

Create a project or open an existing HyperFrames folder containing `index.html`. Home lists your projects, most recently edited first, each with a frame from its picture, its length, and its shape; click one or press Enter to open it. New projects live in `~/Videos/Cutroom`; application data lives in `~/.local/share/cutroom`. Set `CUTROOM_PROJECTS_DIR`, `CUTROOM_DATA_DIR`, or `CUTROOM_PORT` to change those defaults.

Choose Codex or Claude Code in the agent panel. Type `$` to select one of that provider's installed skills. Claude selections are dispatched using its native skill command. The studio shows native approvals and questions in the chat. [Agent behavior](docs/agents.md).

If your agent is signed out, authenticate through its own CLI with `codex login` or `claude auth login`, then refresh the agent configuration in Cutroom.

**Media** at the top left lists the project's video, audio, and images. Import files with **+** or drop them on the panel; they are copied into `assets/`. Right-click a file to rename it, which updates every clip that plays it, or to remove it. Remove moves the file to the project's `trash` folder and Undo moves it back. Double-click a file to play it in the viewer, mark the part you want with I and O, and put it on the timeline with **Insert** (F9), **Overwrite** (F10), or by dragging it onto a track. Insert and Overwrite land on the destination tracks: click a track's code, such as V2 or A2, in its header to choose them. Switch between **Agent**, **Review**, and **Script** below it. Drafts stay in place when you change tabs.

Drop media above the top video track or below the last audio track to add a track. Right-click the track headers to add an empty video or audio track. Click a track name to rename it; Enter saves and Esc cancels. Video enable, audio **M**ute, and **S**olo affect both preview and export. Solo stays with the project, and mute wins over solo. Each change has one undo step. Videos with sound get a linked audio clip automatically.

Drag an audio clip's horizontal gain line up or down to change its level in dB, up to +12 dB. Video clips with embedded sound have the same control. Drag the upper corner handles inward for fade-in and fade-out; the curve and drag readout show the fade length. Each drag is one undo step, and Esc cancels it. The stereo output meters at the timeline's right edge show live dBFS levels, with a 1.5-second peak hold and red clipping indication. Preview and export use the same gain and linear fades.

Choose **Export** or press **Shift+8** to save an MP4. Both In and Out marks select that range by default; choose Whole timeline to include everything. Exports use the project's size and frame rate, with Draft, Standard or High quality. Choose a file name and an existing output folder; the default is `.cutroom/renders` in the project. Existing files are kept. You can dismiss the dialog while it runs and reopen it from the Export indicator. Cancel stops the render and removes partial output. When it finishes, use Open or, in the desktop app, Reveal in folder.

Use **Select**, **Draw**, and **Comment** above the viewer. Their keys are listed in the [keyboard shortcuts](docs/keyboard.md), and Ctrl+Alt+K shows every shortcut in the app. Ctrl+2, Ctrl+4, Ctrl+5 and Ctrl+9 move the keyboard to Media, the timeline, the viewer and the inspector. Right-click a clip, a track header, a media file or a project for its menu. In Script, select a word and Shift-click another to select a passage. Cuts ripple the selected media lane; other tracks keep their authored timing. Complex scripted or linked edits can be handed to the agent.

Select a clip to inspect its recent changes, timing, static opacity, and position. Yellow marks are yours; blue marks are agent edits. Accept clears a reviewed edit, and the clip underline clears when its pending edits are accepted. The Inspector button remembers its visibility and opens a drawer on narrower windows. Type timecode, frames such as `45f`, seconds such as `1.5s`, or percentages. Enter commits, Escape reverts, and dragging a field label scrubs its value. Every committed field is one undo step. Speed keeps timeline duration and changes linked media together. Opacity accepts `Auto` to restore source styles. Position X/Y are offsets in composition pixels from authored placement and animation. Type values such as `-40 px`, scrub the label, or use Up/Down with Shift for ten pixels. Reset clears both offsets in one undo step. Linked sound stays put. Scale, rotation, and keyframe controls are still pending.

See [local transcription](docs/transcription.md) and [editing behavior](docs/editing.md) for supported inputs and undo details.

## MCP

Cutroom must be running. Add the local bridge to an external agent, replacing the path with your checkout:

```sh
codex mcp add cutroom -- bun /absolute/path/to/cutroom/src/server/mcp/stdio.ts
claude mcp add cutroom -- bun /absolute/path/to/cutroom/src/server/mcp/stdio.ts
```

The bridge and the editor use the same project commands and history. Set `CUTROOM_URL` for a nondefault local port. The HTTP endpoint at `/mcp` also accepts local MCP clients. [Available tools](docs/mcp.md).

## Development

```sh
bun run check
bun test
bun run test:e2e
bun run format:check
```

To build and install the Linux desktop app from source:

```sh
bun run package
bun run install:desktop
```

Browser tests need Chromium or a Playwright browser installation. `CUTROOM_BROWSER_PATH` selects an executable. `bun run package` builds the portable Linux distribution.

[Architecture](docs/architecture.md) describes the editor integration and dependency upgrades.

## License

Original Cutroom code is [MIT-licensed](LICENSE). HyperFrames, GSAP, agent runtimes, fonts, and other dependencies retain their own licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).
