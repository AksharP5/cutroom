# MCP tools

The stdio bridge connects to a running local Cutroom server. It accepts only loopback HTTP origins. The local HTTP MCP endpoint is `/mcp`.

| Tool                                                       | Behavior                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `projects_list`                                            | List registered project folders.                                  |
| `project_create`, `project_import`                         | Create a composition or register an existing folder.              |
| `project_read`                                             | Read annotations and transcript metadata.                         |
| `media_list`                                               | Inspect local media elements and their timing.                    |
| `source_read`, `source_write`                              | Read source and save with its exact expected version.             |
| `annotation_add`, `annotation_update`, `annotation_remove` | Add a new timed note, edit its content, or remove an unsent note. |
| `review_list`, `review_add`                                | Read the review queue or add a queued request.                    |
| `review_claim`, `review_complete`, `review_block`          | Start, finish, or ask a question about a queued note.             |
| `review_withdraw`                                          | Withdraw a note the owner's newer message cancels.                |
| `transcripts_list`, `transcript_import`, `transcript_edit` | Read word timing, import a script, and cut or restore words.      |
| `transcription_start`, `transcription_status`              | Run and inspect local transcription.                              |
| `history_list`, `history_undo`, `history_redo`             | Use the editor's shared history.                                  |

Start with `projects_list` and retain the returned project ID. Before a source save, use `source_read` and pass its exact version to `source_write`. A stale version is rejected.

## Review queue

Each message from Cutroom's agent panel includes a digest of unfinished notes and the project ID. Reconcile the message with that queue before working: withdraw what it cancels, with a reason. For a replacement, add the new request with `review_add`, then withdraw the old note with `replacedBy`. During a Cutroom run, the server stamps a withdrawal with the triggering message; a withdrawal from an outside client is recorded as an outside agent.

Claim a note before working on it, then complete it with a short note or block it with a question. Claim and complete also accept new notes, so an outside client can work them directly, and a blocked note once the owner's message answers it. `review_complete` records the latest history entry unless you pass a `revision`. A claim lasts for the current Cutroom run, or for the server's lifetime when made by an outside client; unfinished notes then return to the queue. The owner accepts, sends back, and restores notes in the Review panel; those actions have no MCP tools. Submitted notes cannot be removed with `annotation_remove`; withdraw them instead.

MCP mutations use the same server commands as the interface. Edits to project files and note content appear in its undo history; review status lives outside it. File watchers update the visible preview and the Review panel.
