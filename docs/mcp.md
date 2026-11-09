# MCP tools

The stdio bridge connects to a running local Cutroom server. It accepts only loopback HTTP origins. The local HTTP MCP endpoint is `/mcp`.

| Tool                                                       | Behavior                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `projects_list`                                            | List registered project folders.                             |
| `project_create`, `project_import`                         | Create a composition or register an existing folder.         |
| `project_read`                                             | Read annotations and transcript metadata.                    |
| `media_list`                                               | Inspect local media elements and their timing.               |
| `source_read`, `source_write`                              | Read source and save with its exact expected version.        |
| `annotation_add`, `annotation_update`, `annotation_remove` | Add timed review notes, update status, or remove a note.     |
| `transcripts_list`, `transcript_import`, `transcript_edit` | Read word timing, import a script, and cut or restore words. |
| `transcription_start`, `transcription_status`              | Run and inspect local transcription.                         |
| `history_list`, `history_undo`, `history_redo`             | Use the editor's shared history.                             |

Start with `projects_list` and retain the returned project ID. Before a source save, use `source_read` and pass its exact version to `source_write`. A stale version is rejected.

MCP mutations use the same server commands as the interface. They appear in its undo history, and file watchers update the visible preview.
