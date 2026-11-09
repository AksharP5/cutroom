# Native agents

Cutroom drives installed agents rather than creating its own model loop. Install and authenticate at least one provider before using chat.

| Provider    | Connection                                      | Project permissions                               |
| ----------- | ----------------------------------------------- | ------------------------------------------------- |
| Codex       | `codex app-server` over stdio                   | Workspace writes, with native approval requests   |
| Claude Code | Agent SDK and the installed `claude` executable | Default permission mode and native tool approvals |

Both providers read their own user and project configuration. Cutroom adds a local `cutroom_studio` MCP connection for the running workspace. It does not rewrite global agent settings or copy credentials.

## Skills and models

Type `$` in the composer to choose an enabled native skill. Codex receives explicit skill items with their native paths. Claude receives its native skill command; additional selected skills are requested through its Skill tool.

The model list comes from the provider. Changing models keeps the conversation and native session. A new conversation starts a separate native session.

Use **Refresh agent configuration** after installing a skill or signing in. The provider must be idle to refresh or change models.

## Local context

Messages include the project path, playhead, active composition, selected elements, and pending review notes. Captured review frames are sent as images. Files explicitly chosen outside the project are copied into `.cutroom/attachments/` before use; files already inside the project stay in place.

Conversation presentation is stored in Cutroom's data folder. Native session IDs allow a resumed conversation to use the provider's existing context. Unsent composer text and attachments are saved in browser storage for each project.

If a native run needs approval or an answer, the chat shows that request. Stopping a run cancels its pending questions. Closing Cutroom ends active runs; reopening retains the conversation and permits another message.
