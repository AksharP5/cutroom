# Native agents

Cutroom drives installed agents rather than creating its own model loop. Install and authenticate at least one provider before using chat.

| Provider    | Connection                                      | Project permissions                               |
| ----------- | ----------------------------------------------- | ------------------------------------------------- |
| Codex       | `codex app-server` over stdio                   | Workspace writes, with native approval requests   |
| Claude Code | Agent SDK and the installed `claude` executable | Default permission mode and native tool approvals |

Both providers read their own user and project configuration. Cutroom adds a local `cutroom_studio` MCP connection for the running workspace. It does not rewrite global agent settings or copy credentials.

## Skills and models

Ask for an edit in your own words. The agent loads relevant installed HyperFrames skills on its own. You can also type `$` in the composer to choose an enabled native skill. Codex receives explicit skill items with their native paths. Claude receives its native skill command; additional selected skills are requested through its Skill tool. If two installed skills share a name, the picker shows both paths and remembers the one you choose with the draft. A name typed without choosing a path uses the first enabled match returned by the native runtime.

The provider lists the available models and which reasoning efforts each supports. You can set an effort per chat or clear it to use the provider's default. Changing the model or effort keeps the chat and native session. A new chat starts a separate native session when you send the first message. The provider and model controls lock while the open chat is working or opening. Text typed for the next message stays in the composer.

Each project has its own chats. Select the chat title to switch, rename, or delete a chat. The list marks chats that are working or waiting for you. You can switch while a run continues and return to it to respond or stop it. A working chat must be stopped before you can delete it. Deleting a chat removes Cutroom's history for that chat. The provider keeps its native session.

The plus button opens a new chat and shows up to five recent chats. Cutroom remembers the last saved chat you opened in each project. If it is gone, Cutroom opens the most recent remaining chat.

Use **Refresh agents** at the bottom of the chat list after installing a skill or signing in. The open chat must be idle to refresh or change the model or effort.

## Local context

When Cutroom starts or resumes a native session, it tells the agent where the HyperFrames project is and to use the Cutroom tools and relevant installed skills. Each turn starts with your message, followed by a context block with the project name and path, playhead, open composition, selected clips, and any review digest. Clip context includes each selected clip’s id, name, kind, and start and end in seconds. Attached file paths follow the context. The first selected clip is also published where `hyperframes preview --context --json --context-fields selection --port <Cutroom's port>` reads it, so an agent can check the current selection mid-turn; it carries only that clip's project data. Captured frames of new review notes are sent as images. Files explicitly chosen outside the project are copied into `.cutroom/attachments/` before use; files already inside the project stay in place.

The MCP instructions ask agents to create each animated title as its own sub-composition file with `source_write` and `expectedVersion: null`, so timeline edits carry its animation with it. New projects load their local `assets/vendor/gsap.min.js`; keep that script tag in the root HTML. [Animated titles](mcp.md#animated-titles) has the pattern. Asked for several versions of one thing, an agent writes each as such a file and puts them all on one clip with `clip_versions_set`, so you can compare them there and keep one; [Versions](mcp.md#versions) has the steps.

Chat history is stored in Cutroom's data folder. Native session IDs allow a resumed chat to use the provider's existing context. Unsent composer text and attachments are saved in browser storage for each project.

If a native run needs approval or an answer, the chat shows that request. Stopping a run cancels its pending questions. Closing Cutroom ends active runs; reopening retains the chat and permits another message.

## Transcript

Agents mention review notes when that turn changed one, when you explicitly ask about notes, or when a note is needed to explain a blocker. Otherwise they skip recaps of untouched queued notes.

Your messages have a yellow rule, and project edits have a blue rule. A finished turn shows its elapsed time at its end when timestamps are available. Hover a code block or tab to **Copy code** to copy its contents. The tool calls between two replies fold into one line, such as "Read 6 files, ran 3 commands, 2 more", whose counts grow while the agent works. Select it to see every call in order, and any call to see its output. Two kinds of call always keep their own row: one that failed, with the reason, and one that changed the project, naming the files or clips.

## Approvals and changed clips

`timeline_view` and other Cutroom reads run without approval unless your native settings ask. So does queue bookkeeping: claiming a note, finishing it, asking a question about it, or releasing it changes only its status, never the project. Edits, withdrawals, and exports ask; [MCP approvals](mcp.md#approvals) lists every tool.

A timeline approval lists each command in plain words, such as "Move Call to action to 00:00:24:00". Other approvals use a short question, such as "Run this command?" with the command in full. Long command lists scroll while Allow and Deny stay visible. **Details** shows the exact request. On an edit approval, choose **Always allow Cutroom edits** to allow Cutroom's own edit tools for this project. Shell commands and other MCP servers keep their own permissions. Project creation and import always prompt separately. Your native ask rules still apply. The Agent panel shows the saved choice and **Revoke**; revoking stops any active run too.

Source editing is limited to composition HTML, CSS, JavaScript, TypeScript, SVG, and JSON. Hidden paths, agent instructions, and native tooling configuration are protected for everyone, even after a one-time approval. Change those files outside Cutroom through your native editor's permissions. The embedded editor also refuses renames when its automatic reference updates could rewrite protected text files.

Clips changed through Cutroom's timeline, script, or HTML source tools have a blue underline. Accept their completed review note to clear it, or use **Accept agent changes** in Review for edits made directly from chat. Editing a clip yourself also clears its underline. When several notes are claimed, the agent passes `noteId` on each edit so accepting a note clears only its own clips.

## Review queue

Sending a message queues every new review note. The server then adds a digest of every unfinished note to that message: its ID, status, time, composition, element, frame path, a one-line summary, your replies and send-back notes, and any question or completion note. An unrelated follow-up still carries earlier notes, so the agent never loses them.

The digest asks the agent to reconcile the message with the queue first. Newer intent wins: when the message cancels or replaces a note, the agent withdraws it with a reason instead of doing it, and the server records which message withdrew it. A message can also answer a note the agent blocked on; the agent then claims it with that answer, which is saved on the note as a chat answer, and continues. The agent works through the queue with the [review tools](mcp.md#review-queue). When a run ends, fails, or is stopped, notes it claimed but did not finish return to the queue. Claims left by a closed app return on the next read.

While the agent runs, its status and elapsed time appear above the composer, followed by any approval and queued follow-ups. **Stop agent** sits beside **Queue follow-up**, which saves your message for that chat. Follow-ups run in order after the current turn finishes, each with the current review queue. Remove a message using the cross next to it. After you stop the agent, close Cutroom, or a turn fails, pending follow-ups stay saved until you choose **Resume queue**. An interrupted follow-up stays queued as well. Check any partial edits before running it again.

Cutroom runs one chat at a time per project. Sending from a second chat while another is working returns an error until it finishes or is stopped. Each chat's native agent gets a private token on its MCP connection, so its review actions are credited to the running message, and the token is refused on other projects or once the run ends. Any other MCP client, even one active during that run, is recorded as an outside agent.

Hover a Review row to move it up or down in the queue, or withdraw it. The order and withdrawal reason survive restarting Cutroom.

## Shared chats

Link a T3 Code thread to pick up a chat you already started there. Cutroom lists threads by project folder and also accepts a bare thread ID from another folder. T3 Code runs the agent with its own settings. Answer questions, approve tool calls, and stop runs in T3 Code.

Cutroom mirrors the thread's recent messages and status while the chat is open. It sends your message, one line naming the project, the current video context, and a digest of unfinished review notes. Attachments and note frames go as absolute local file paths. A busy T3 Code thread queues the message for its next turn. The attached paths and context also appear in T3 Code's transcript.

All paths below are under `/api/cutroom`.

- `GET /projects/:id/t3-threads` returns `{ available, threads, reason? }`. Each thread has `threadId`, `title`, `link`, `status`, `providerInstanceId`, `model`, `createdAt`, and `updatedAt`. A folder missing from T3 Code returns an empty list. When the CLI or app is unavailable, `available` is false and `reason` explains why.
- `POST /projects/:id/t3-threads/link` takes `{ threadId }` and returns the linked session with HTTP 201, including on repeat requests. Session summaries and snapshots include `t3Thread: { threadId, link }` for linked chats. The existing `provider` field identifies the underlying provider for display.
- Use the existing session `/events` stream for snapshots, messages and status. Send through `/turns` or `/follow-ups`. Both return the session plus `queued: boolean` for T3 Code's delivery. Use `/turns` and the same `text`, `context`, and `attachments` fields for Send notes. T3 Code manages the queue and skills, so Cutroom's queue and model controls do not apply. `/interrupt` returns 409 with “Stop this run in T3 Code.” A chat awaiting approval or an answer reports `waiting` and shows “Answer in T3 Code.”
