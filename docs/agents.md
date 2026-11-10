# Native agents

Cutroom drives installed agents rather than creating its own model loop. Install and authenticate at least one provider before using chat.

| Provider    | Connection                                      | Project permissions                               |
| ----------- | ----------------------------------------------- | ------------------------------------------------- |
| Codex       | `codex app-server` over stdio                   | Workspace writes, with native approval requests   |
| Claude Code | Agent SDK and the installed `claude` executable | Default permission mode and native tool approvals |

Both providers read their own user and project configuration. Cutroom adds a local `cutroom_studio` MCP connection for the running workspace. It does not rewrite global agent settings or copy credentials.

## Skills and models

Type `$` in the composer to choose an enabled native skill. Codex receives explicit skill items with their native paths. Claude receives its native skill command; additional selected skills are requested through its Skill tool.

The model list comes from the provider. Changing models keeps the conversation and native session. A new conversation starts a separate native session. Conversation and provider controls stay locked while a session opens or accepts a message. Text typed for the next message stays in the composer.

Use **Refresh agent configuration** after installing a skill or signing in. The provider must be idle to refresh or change models.

## Local context

Messages include the project path, playhead, active composition, and selected elements. Captured frames of new review notes are sent as images. Files explicitly chosen outside the project are copied into `.cutroom/attachments/` before use; files already inside the project stay in place.

Conversation presentation is stored in Cutroom's data folder. Native session IDs allow a resumed conversation to use the provider's existing context. Unsent composer text and attachments are saved in browser storage for each project.

If a native run needs approval or an answer, the chat shows that request. Stopping a run cancels its pending questions. Closing Cutroom ends active runs; reopening retains the conversation and permits another message.

## Review queue

Sending a message queues every new review note. The server then adds a digest of every unfinished note to that message: its ID, status, time, composition, element, frame path, a one-line summary, your replies and send-back notes, and any question or completion note. An unrelated follow-up still carries earlier notes, so the agent never loses them.

The digest asks the agent to reconcile the message with the queue first. Newer intent wins: when the message cancels or replaces a note, the agent withdraws it with a reason instead of doing it, and the server records which message withdrew it. A message can also answer a note the agent blocked on; the agent then claims it with that answer, which is saved on the note as a chat answer, and continues. The agent works through the queue with the [review tools](mcp.md#review-queue). When a run ends, fails, or is stopped, notes it claimed but did not finish return to the queue. Claims left by a closed app return on the next read.

One conversation per project works at a time. Sending from a second conversation while another is working returns an error until it finishes or is stopped. Cutroom gives its native agents' MCP connection a private token, so their review actions are credited to the running message. Any other MCP client, even one active during that run, is recorded as an outside agent.
