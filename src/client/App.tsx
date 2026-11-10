import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CaretDown,
  Check,
  FilmSlate,
  FolderOpen,
  Folders,
  GearSix,
  Plus,
  SidebarSimple,
  TerminalWindow,
} from "@phosphor-icons/react";
import { z } from "zod";
import {
  AnnotationSchema,
  ProjectNotebookSchema,
  ProjectSchema,
  type Annotation,
  type Project,
} from "../shared/project";
import type {
  EditorContext,
  EditorMode,
  EditorReviewDraft,
} from "../shared/editor";
import { api, json, timecode } from "./api";
import { version } from "../shared/version";
import { ChatPanel } from "./components/ChatPanel";
import { EmptyState } from "./components/EmptyState";
import { FileDialog } from "./components/FileDialog";
import { affectsMediaList, MediaPanel } from "./components/MediaPanel";
import { Modal } from "./components/Modal";
import { ReviewPanel } from "./components/ReviewPanel";
import { saveReviewNote } from "./review";
import { EditorToolsContext } from "./editor/EditorTools";
import { ScriptPanel } from "./components/ScriptPanel";
import { useWorkspace } from "./workspace";

const Editor = lazy(() =>
  import("./editor/CutroomEditor").then((module) => ({
    default: module.CutroomEditor,
  })),
);
const projectsSchema = z.object({ projects: z.array(ProjectSchema) });
const statusSchema = z.object({
  version: z.string(),
  projectsDir: z.string(),
  dataDir: z.string(),
  mcpCommand: z.string(),
});
const emptyDocument: z.infer<typeof ProjectNotebookSchema> = {
  annotations: [],
  transcriptVersion: "",
};

class EditorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error)
      return (
        <div className="editor-failure">
          <h2>The editor could not open.</h2>
          <p>{this.state.error}</p>
          <button
            className="secondary-button"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    return this.props.children;
  }
}

function projectFromHash() {
  const match = /^#project\/([^?]+)/.exec(window.location.hash);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(projectFromHash);
  const [documentState, setDocumentState] = useState<{
    projectId: string;
    document: z.infer<typeof ProjectNotebookSchema>;
  } | null>(null);
  const projectDocument =
    documentState?.projectId === projectId
      ? documentState.document
      : emptyDocument;
  const [status, setStatus] = useState<z.infer<typeof statusSchema> | null>(
    null,
  );
  const [mode, setMode] = useState<EditorMode>("select");
  const [sourceRevision, setSourceRevision] = useState(0);
  const [mediaRevision, setMediaRevision] = useState(0);
  const [panel, setPanel] = useState<"review" | "script">("review");
  const [reviewState, setReviewState] = useState<{
    projectId: string;
    draft: EditorReviewDraft;
  } | null>(null);
  const reviewDraft =
    reviewState?.projectId === projectId ? reviewState.draft : null;
  const [promptState, setPromptState] = useState<{
    projectId: string;
    text: string;
  } | null>(null);
  const prompt = promptState?.projectId === projectId ? promptState.text : null;
  const [workPanel, setWorkPanel] = useState<"agent" | "notebook" | null>(
    "agent",
  );
  const chatVisible = workPanel === "agent";
  const notebookVisible = workPanel === "notebook";
  const exporting = useWorkspace((state) => state.exporting);
  const openNotes = projectDocument.annotations.filter(
    (item) => item.status === "open",
  ).length;
  const [dialog, setDialog] = useState<
    "projects" | "create" | "settings" | null
  >(null);
  const [picker, setPicker] = useState<"file" | "directory" | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const attachmentResolve = useRef<{
    projectId: string;
    resolve: (path: string | null) => void;
  } | null>(null);
  const context = useRef<EditorContext | null>(null);
  const documentRequest = useRef(0);
  const projectListRequest = useRef(0);
  const projectOpening = useRef<object | null>(null);
  const activeProjectId = useRef(projectId);
  activeProjectId.current = projectId;
  const project = projects.find((item) => item.id === projectId);

  const loadProjects = useCallback(async () => {
    const request = ++projectListRequest.current;
    const result = await api("/projects", projectsSchema);
    if (request === projectListRequest.current) setProjects(result.projects);
    return result.projects;
  }, []);
  const refreshDocument = useCallback(async () => {
    if (!projectId) return;
    const request = ++documentRequest.current;
    const result = await api(
      `/projects/${projectId}/notebook`,
      ProjectNotebookSchema,
    );
    if (
      activeProjectId.current === projectId &&
      request === documentRequest.current
    )
      setDocumentState({ projectId, document: result });
  }, [projectId]);

  useEffect(() => {
    void loadProjects().catch((error: unknown) =>
      setError(error instanceof Error ? error.message : String(error)),
    );
    void api("/status", statusSchema)
      .then(setStatus)
      .catch((error: unknown) =>
        setError(error instanceof Error ? error.message : String(error)),
      );
    const change = () => setProjectId(projectFromHash());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, [loadProjects]);

  useEffect(() => {
    projectOpening.current = null;
    setCreating(false);
    setReviewState(null);
    attachmentResolve.current?.resolve(null);
    attachmentResolve.current = null;
    setPicker((current) => (current === "file" ? null : current));
    context.current = null;
    void refreshDocument().catch((error: unknown) =>
      setError(error instanceof Error ? error.message : String(error)),
    );
    if (!projectId) return;
    const events = new EventSource(`/api/cutroom/projects/${projectId}/events`);
    events.onmessage = (event) => {
      try {
        const payload = z
          .object({ changed: z.string() })
          .parse(JSON.parse(event.data));
        if (/\.html?$/i.test(payload.changed))
          setSourceRevision((value) => value + 1);
        else if (payload.changed !== "cutroom.json") {
          if (affectsMediaList(payload.changed))
            setMediaRevision((value) => value + 1);
          return;
        }
      } catch {
        return;
      }
      void refreshDocument().catch(() => {});
    };
    return () => events.close();
  }, [projectId, refreshDocument]);

  useEffect(() => {
    function key(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("input,textarea,select,[contenteditable=true]") ||
          target.closest("dialog"))
      )
        return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const modes = { v: "select", d: "draw", c: "comment" } as const;
      const pressed = event.key.toLowerCase();
      if (pressed === "v" || pressed === "d" || pressed === "c") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setMode(modes[pressed]);
      }
      if (event.key === "Escape") {
        setMode("select");
        setReviewState(null);
      }
    }
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  function closeCreateDialog() {
    projectOpening.current = null;
    setCreating(false);
    setDialog(null);
  }
  function openProject(next: Project) {
    projectOpening.current = null;
    setCreating(false);
    window.location.hash = `project/${encodeURIComponent(next.id)}?v=1&rc=1&tv=1`;
    setProjectId(next.id);
    setDialog(null);
    setError("");
    document.title = `${next.name} · Cutroom`;
  }
  const onContext = useCallback((value: EditorContext) => {
    context.current = value;
  }, []);
  const onReview = useCallback(
    (value: EditorReviewDraft) => {
      if (!projectId || activeProjectId.current !== projectId) return;
      setReviewState({ projectId, draft: value });
      setPanel("review");
      setWorkPanel("notebook");
      setMode("select");
    },
    [projectId],
  );
  const consumePrompt = useCallback(() => setPromptState(null), []);
  const ask = useCallback(
    (value: string) => {
      if (!projectId || activeProjectId.current !== projectId) return;
      setPromptState({ projectId, text: value });
      setWorkPanel("agent");
    },
    [projectId],
  );
  const seek = useCallback(async (time: number, compositionPath?: string) => {
    const expectedProject = activeProjectId.current;
    const { seekEditor } = await import("./editor/CutroomEditor");
    if (activeProjectId.current === expectedProject)
      seekEditor(time, compositionPath);
  }, []);
  const changed = useCallback(async () => {
    await refreshDocument();
    if (activeProjectId.current !== projectId) return;
    const { refreshEditor } = await import("./editor/CutroomEditor");
    refreshEditor();
  }, [projectId, refreshDocument]);
  function getContext() {
    const notes = projectDocument.annotations.filter(
      (item) => item.status === "open",
    );
    return JSON.stringify(
      {
        project: project ? { name: project.name, path: project.path } : null,
        editor: context.current,
        reviewNotes: notes,
      },
      null,
      2,
    );
  }
  async function markSent() {
    const notes = projectDocument.annotations.filter(
      (item) => item.status === "open",
    );
    await Promise.all(
      notes.map((item) =>
        api(
          `/projects/${projectId}/annotations/${item.id}`,
          AnnotationSchema,
          json("PATCH", { status: "sent" }),
        ),
      ),
    );
    await refreshDocument();
  }

  return (
    <div className="cutroom-app">
      <header className="app-header">
        <button
          className="wordmark"
          aria-label="Cutroom projects"
          onClick={() => setDialog("projects")}
        >
          <FilmSlate size={16} />
          <span>cutroom</span>
        </button>
        <span className="header-divider" />
        <button
          className="project-switcher"
          onClick={() => setDialog("projects")}
        >
          <span>{project?.name ?? "Projects"}</span>
          <CaretDown size={10} weight="bold" />
        </button>
        <div className="header-space" />
        {project && (
          <>
            <button
              className={`icon-button ${notebookVisible ? "active" : ""}`}
              aria-label="Toggle notebook"
              aria-pressed={notebookVisible}
              onClick={() =>
                setWorkPanel((value) =>
                  value === "notebook" ? null : "notebook",
                )
              }
            >
              <SidebarSimple />
            </button>
            <button
              className={`icon-button ${chatVisible ? "active" : ""}`}
              aria-label="Toggle agent chat"
              aria-pressed={chatVisible}
              onClick={() =>
                setWorkPanel((value) => (value === "agent" ? null : "agent"))
              }
            >
              <TerminalWindow />
            </button>
          </>
        )}
        <button
          className="icon-button"
          aria-label="Settings"
          onClick={() => setDialog("settings")}
        >
          <GearSix />
        </button>
      </header>
      {error && (
        <div className="app-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {!project ? (
        <EmptyState
          onCreate={() => setDialog("create")}
          onImport={() => setPicker("directory")}
        />
      ) : (
        <main className={`workspace ${workPanel ? "with-work-panel" : ""}`}>
          <MediaPanel
            key={project.id}
            projectId={project.id}
            revision={mediaRevision}
            hidden={!workPanel}
          />
          <section
            className="work-panel"
            aria-label="Project workspace"
            hidden={!workPanel}
          >
            <nav className="workspace-tabs" aria-label="Workspace panels">
              <button
                className={chatVisible ? "active" : ""}
                aria-pressed={chatVisible}
                onClick={() => setWorkPanel("agent")}
              >
                Agent
              </button>
              <button
                aria-label="Review"
                className={
                  notebookVisible && panel === "review" ? "active" : ""
                }
                aria-pressed={notebookVisible && panel === "review"}
                onClick={() => {
                  setPanel("review");
                  setWorkPanel("notebook");
                }}
              >
                Review
                {openNotes > 0 && (
                  <span className="note-count">{openNotes}</span>
                )}
              </button>
              <button
                className={
                  notebookVisible && panel === "script" ? "active" : ""
                }
                aria-pressed={notebookVisible && panel === "script"}
                onClick={() => {
                  setPanel("script");
                  setWorkPanel("notebook");
                }}
              >
                Script
              </button>
            </nav>
            <aside
              key={`notebook:${project.id}`}
              className="notebook"
              hidden={!notebookVisible}
            >
              <div className="notebook-content">
                <div hidden={panel !== "review"}>
                  <ReviewPanel
                    projectId={project.id}
                    annotations={projectDocument.annotations}
                    draft={reviewDraft}
                    onCancel={() => setReviewState(null)}
                    onSave={async (body) => {
                      if (!reviewDraft) return;
                      const captureError = await saveReviewNote(
                        project.id,
                        reviewDraft,
                        body,
                      );
                      setReviewState((current) =>
                        current?.draft === reviewDraft ? null : current,
                      );
                      await refreshDocument();
                      if (
                        captureError &&
                        activeProjectId.current === project.id
                      )
                        setError(
                          `Note saved without a frame image. ${captureError}`,
                        );
                    }}
                    onSeek={(annotation) =>
                      void seek(annotation.time, annotation.compositionPath)
                    }
                    onResolve={async (annotation) => {
                      await api(
                        `/projects/${projectId}/annotations/${annotation.id}`,
                        AnnotationSchema,
                        json("PATCH", { status: "resolved" }),
                      );
                      await refreshDocument();
                    }}
                    onDelete={async (annotation) => {
                      await api(
                        `/projects/${projectId}/annotations/${annotation.id}`,
                        z.unknown(),
                        json("DELETE"),
                      );
                      await refreshDocument();
                    }}
                    onSend={() =>
                      ask(
                        `Apply my ${projectDocument.annotations.filter((item) => item.status === "open").length} pending review notes. They are included with this message's project context.`,
                      )
                    }
                  />
                </div>
                <div hidden={panel !== "script"}>
                  <ScriptPanel
                    projectId={project.id}
                    revision={`${projectDocument.transcriptVersion}:${sourceRevision}`}
                    visible={panel === "script" && notebookVisible}
                    onChange={changed}
                    onSeek={seek}
                    onAsk={ask}
                  />
                </div>
              </div>
            </aside>
            <ChatPanel
              key={project.id}
              projectId={project.id}
              visible={chatVisible}
              getContext={getContext}
              getReviewAttachments={() =>
                projectDocument.annotations
                  .filter((note) => note.status === "open" && note.framePath)
                  .flatMap((note) => (note.framePath ? [note.framePath] : []))
              }
              onSent={() =>
                void markSent().catch((error: unknown) =>
                  setError(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
              }
              prompt={prompt}
              onPromptConsumed={consumePrompt}
              pickAttachment={() =>
                new Promise((resolve) => {
                  attachmentResolve.current = {
                    projectId: project.id,
                    resolve,
                  };
                  setPicker("file");
                })
              }
            />
          </section>
          <section className="editor-workspace" aria-label="Video editor">
            <EditorToolsContext.Provider
              value={{ mode, setMode, focusEditor: () => setWorkPanel(null) }}
            >
              <EditorBoundary key={project.id}>
                <Suspense
                  fallback={
                    <div className="editor-loading">
                      <span>Opening editor</span>
                      <div className="loading-line" />
                    </div>
                  }
                >
                  <Editor
                    projectId={project.id}
                    mode={mode}
                    onContext={onContext}
                    onReview={onReview}
                    onAskAgent={ask}
                  />
                </Suspense>
              </EditorBoundary>
            </EditorToolsContext.Provider>
          </section>
          <footer className="status-bar">
            <button
              className="status-path"
              title={`Copy ${project.path}`}
              onClick={() => void navigator.clipboard.writeText(project.path)}
            >
              {project.path.replace(/^\/home\/[^/]+/, "~")}
            </button>
            {openNotes > 0 && (
              <button
                onClick={() => {
                  setPanel("review");
                  setWorkPanel("notebook");
                }}
              >
                {openNotes} open {openNotes === 1 ? "note" : "notes"}
              </button>
            )}
            {exporting && <span className="status-job">Exporting</span>}
            <span className="status-space" />
            <span>Cutroom {status?.version ?? version}</span>
          </footer>
        </main>
      )}
      {dialog === "projects" && (
        <Modal title="Projects" onClose={() => setDialog(null)}>
          <div className="project-actions">
            <button
              className="primary-button"
              onClick={() => setDialog("create")}
            >
              <Plus />
              New project
            </button>
            <button
              className="secondary-button"
              onClick={() => {
                setDialog(null);
                setPicker("directory");
              }}
            >
              <FolderOpen />
              Open folder
            </button>
          </div>
          <div className="project-list">
            {projects.map((item) => (
              <button
                key={item.id}
                className="project-row"
                onClick={() => openProject(item)}
              >
                <Folders size={23} weight="light" />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.path.replace(/^\/home\/[^/]+/, "~")}</small>
                </span>
                {item.id === projectId && <Check size={16} />}
              </button>
            ))}
            {projects.length === 0 && (
              <p className="quiet-message">Your projects will appear here.</p>
            )}
          </div>
        </Modal>
      )}
      {dialog === "create" && (
        <Modal title="New project" onClose={closeCreateDialog}>
          <form
            className="project-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || projectOpening.current) return;
              const operation = {};
              projectOpening.current = operation;
              setCreating(true);
              setError("");
              void api("/projects", ProjectSchema, json("POST", { name }))
                .then(async (created) => {
                  await loadProjects();
                  if (projectOpening.current !== operation) return;
                  openProject(created);
                  setName("");
                })
                .catch((error: unknown) => {
                  if (projectOpening.current === operation)
                    setError(
                      error instanceof Error ? error.message : String(error),
                    );
                })
                .finally(() => {
                  if (projectOpening.current === operation) {
                    projectOpening.current = null;
                    setCreating(false);
                  }
                });
            }}
          >
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Untitled project"
              required
              maxLength={120}
            />
            <p className="field-help">
              Saved in{" "}
              {status?.projectsDir.replace(/^\/home\/[^/]+/, "~") ??
                "your projects folder"}
            </p>
            <footer className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={closeCreateDialog}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={!name.trim() || creating}
              >
                {creating ? "Creating…" : "Create project"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {dialog === "settings" && (
        <Modal title="Workspace settings" onClose={() => setDialog(null)}>
          <div className="settings-content">
            <section>
              <h3>Local folders</h3>
              <label>Projects</label>
              <code>{status?.projectsDir}</code>
              <label>Application data</label>
              <code>{status?.dataDir}</code>
            </section>
            <section>
              <h3>Connect an external agent</h3>
              <p>Add this command as a local MCP server in your agent.</p>
              <pre>{status?.mcpCommand}</pre>
              <button
                className="secondary-button"
                onClick={() =>
                  void navigator.clipboard.writeText(status?.mcpCommand ?? "")
                }
              >
                Copy command
              </button>
            </section>
            <section>
              <h3>Your native agents</h3>
              <p>
                Codex and Claude Code use their own skills, configuration,
                authentication, and project instructions. Choose an agent in the
                chat panel.
              </p>
            </section>
            <footer>Cutroom {status?.version ?? version}</footer>
          </div>
        </Modal>
      )}
      {picker && (
        <FileDialog
          kind={picker}
          initialPath={project?.path ?? status?.projectsDir ?? "/home"}
          onClose={() => {
            setPicker(null);
            attachmentResolve.current?.resolve(null);
            attachmentResolve.current = null;
          }}
          onSelect={(path) => {
            const kind = picker;
            setPicker(null);
            if (kind === "file") {
              const pending = attachmentResolve.current;
              attachmentResolve.current = null;
              if (!pending) return;
              void api(
                `/projects/${pending.projectId}/attachments/import`,
                z.object({ path: z.string() }),
                json("POST", { path }),
              )
                .then((attachment) => pending.resolve(attachment.path))
                .catch((error: unknown) => {
                  pending.resolve(null);
                  if (activeProjectId.current === pending.projectId)
                    setError(
                      error instanceof Error ? error.message : String(error),
                    );
                });
              return;
            }
            const operation = {};
            projectOpening.current = operation;
            void api("/projects/import", ProjectSchema, json("POST", { path }))
              .then(async (imported) => {
                await loadProjects();
                if (projectOpening.current === operation) openProject(imported);
              })
              .catch((error: unknown) => {
                if (projectOpening.current === operation)
                  setError(
                    error instanceof Error ? error.message : String(error),
                  );
              })
              .finally(() => {
                if (projectOpening.current === operation)
                  projectOpening.current = null;
              });
          }}
        />
      )}
    </div>
  );
}
