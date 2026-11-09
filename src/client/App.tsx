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
  ArrowsOutSimple,
  CaretDown,
  ChatTeardropText,
  Check,
  Cursor,
  FilmSlate,
  FolderOpen,
  Folders,
  GearSix,
  PencilSimple,
  Plus,
  SidebarSimple,
  TerminalWindow,
  TextAlignLeft,
} from "@phosphor-icons/react";
import { z } from "zod";
import {
  AnnotationSchema,
  ProjectDocumentSchema,
  ProjectSchema,
  type Annotation,
  type Project,
  type ProjectDocument,
} from "../shared/project";
import type {
  EditorContext,
  EditorMode,
  EditorReviewDraft,
} from "../shared/editor";
import { api, json, timecode } from "./api";
import { ChatPanel } from "./components/ChatPanel";
import { EmptyState } from "./components/EmptyState";
import { FileDialog } from "./components/FileDialog";
import { Modal } from "./components/Modal";
import { ReviewPanel } from "./components/ReviewPanel";
import { saveReviewNote } from "./review";
import { ScriptPanel } from "./components/ScriptPanel";

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
const emptyDocument: ProjectDocument = {
  schemaVersion: 1,
  annotations: [],
  transcripts: [],
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
  const [projectDocument, setProjectDocument] =
    useState<ProjectDocument>(emptyDocument);
  const [status, setStatus] = useState<z.infer<typeof statusSchema> | null>(
    null,
  );
  const [mode, setMode] = useState<EditorMode>("select");
  const [panel, setPanel] = useState<"review" | "script">("review");
  const [reviewDraft, setReviewDraft] = useState<EditorReviewDraft | null>(
    null,
  );
  const [prompt, setPrompt] = useState<string | null>(null);
  const [chatVisible, setChatVisible] = useState(true);
  const [notebookVisible, setNotebookVisible] = useState(true);
  const [dialog, setDialog] = useState<
    "projects" | "create" | "settings" | null
  >(null);
  const [picker, setPicker] = useState<"file" | "directory" | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const attachmentResolve = useRef<((path: string | null) => void) | null>(
    null,
  );
  const context = useRef<EditorContext | null>(null);
  const documentRequest = useRef(0);
  const activeProjectId = useRef(projectId);
  activeProjectId.current = projectId;
  const project = projects.find((item) => item.id === projectId);

  const loadProjects = useCallback(async () => {
    const result = await api("/projects", projectsSchema);
    setProjects(result.projects);
    return result.projects;
  }, []);
  const refreshDocument = useCallback(async () => {
    if (!projectId) return;
    const request = ++documentRequest.current;
    const result = await api(
      `/projects/${projectId}/document`,
      ProjectDocumentSchema,
    );
    if (
      activeProjectId.current === projectId &&
      request === documentRequest.current
    )
      setProjectDocument(result);
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
    setProjectDocument(emptyDocument);
    setReviewDraft(null);
    context.current = null;
    void refreshDocument().catch((error: unknown) =>
      setError(error instanceof Error ? error.message : String(error)),
    );
    if (!projectId) return;
    const events = new EventSource(`/api/cutroom/projects/${projectId}/events`);
    events.onmessage = () => {
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
        setReviewDraft(null);
      }
    }
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  function openProject(next: Project) {
    window.location.hash = `project/${encodeURIComponent(next.id)}?v=1&rc=1&tv=1`;
    setProjectId(next.id);
    setDialog(null);
    setError("");
    document.title = `${next.name} · Cutroom`;
  }
  const onContext = useCallback((value: EditorContext) => {
    context.current = value;
  }, []);
  const onReview = useCallback((value: EditorReviewDraft) => {
    setReviewDraft(value);
    setPanel("review");
    setNotebookVisible(true);
    setMode("select");
  }, []);
  const consumePrompt = useCallback(() => setPrompt(null), []);
  const ask = useCallback((value: string) => {
    setPrompt(value);
    setChatVisible(true);
  }, []);
  async function seek(time: number) {
    const { seekEditor } = await import("./editor/CutroomEditor");
    seekEditor(time);
  }
  const changed = useCallback(async () => {
    await refreshDocument();
    const { refreshEditor } = await import("./editor/CutroomEditor");
    refreshEditor();
  }, [refreshDocument]);
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
          <FilmSlate size={23} weight="light" />
          <span>cutroom</span>
        </button>
        <span className="header-divider" />
        <button
          className="project-switcher"
          onClick={() => setDialog("projects")}
        >
          <span>{project?.name ?? "Workspace"}</span>
          <CaretDown size={12} />
        </button>
        <div className="header-space" />
        <span className="local-indicator">
          <span />
          Local workspace
        </span>
        {project && (
          <>
            <button
              className={`icon-button ${notebookVisible ? "active" : ""}`}
              aria-label="Toggle notebook"
              aria-pressed={notebookVisible}
              onClick={() => setNotebookVisible((value) => !value)}
            >
              <SidebarSimple />
            </button>
            <button
              className={`icon-button ${chatVisible ? "active" : ""}`}
              aria-label="Toggle agent chat"
              aria-pressed={chatVisible}
              onClick={() => setChatVisible((value) => !value)}
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
        <main
          className={`workspace ${notebookVisible ? "with-notebook" : ""} ${chatVisible ? "with-chat" : ""}`}
        >
          <aside className="notebook" hidden={!notebookVisible}>
            <header className="panel-heading">
              <span className="panel-title">Notebook</span>
              <span className="quiet-label">
                {projectDocument.annotations.filter(
                  (item) => item.status === "open",
                ).length || ""}
              </span>
            </header>
            <nav className="notebook-tabs" aria-label="Notebook">
              <button
                className={panel === "review" ? "active" : ""}
                onClick={() => setPanel("review")}
              >
                <ChatTeardropText size={15} />
                Review
              </button>
              <button
                className={panel === "script" ? "active" : ""}
                onClick={() => setPanel("script")}
              >
                <TextAlignLeft size={15} />
                Script
              </button>
            </nav>
            <div className="notebook-content">
              <div hidden={panel !== "review"}>
                <ReviewPanel
                  projectId={project.id}
                  annotations={projectDocument.annotations}
                  draft={reviewDraft}
                  onCancel={() => setReviewDraft(null)}
                  onSave={async (body) => {
                    if (!reviewDraft) return;
                    const captureError = await saveReviewNote(
                      project.id,
                      reviewDraft,
                      body,
                    );
                    setReviewDraft(null);
                    await refreshDocument();
                    if (captureError)
                      setError(
                        `Note saved without a frame image. ${captureError}`,
                      );
                  }}
                  onSeek={(time) => void seek(time)}
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
                  transcripts={projectDocument.transcripts}
                  onChange={changed}
                  onSeek={(time) => void seek(time)}
                  onAsk={ask}
                />
              </div>
            </div>
            <button
              className="project-location"
              title={project.path}
              onClick={() => void navigator.clipboard.writeText(project.path)}
            >
              <FolderOpen size={14} />
              <span>{project.path.replace(/^\/home\/[^/]+/, "~")}</span>
            </button>
          </aside>
          <section className="editor-workspace" aria-label="Video editor">
            <div className="editor-topbar">
              <div
                className="mode-switch"
                role="toolbar"
                aria-label="Preview tools"
              >
                {(
                  [
                    { id: "select", label: "Select", key: "V", icon: Cursor },
                    { id: "draw", label: "Draw", key: "D", icon: PencilSimple },
                    {
                      id: "comment",
                      label: "Comment",
                      key: "C",
                      icon: ChatTeardropText,
                    },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    className={mode === item.id ? "active" : ""}
                    aria-label={`${item.label} (${item.key})`}
                    aria-pressed={mode === item.id}
                    onClick={() => setMode(item.id)}
                  >
                    <item.icon size={16} />
                    <span>{item.label}</span>
                    <kbd>{item.key}</kbd>
                  </button>
                ))}
              </div>
              <span className="editor-mode-hint">
                {mode === "draw"
                  ? "Draw over the picture"
                  : mode === "comment"
                    ? "Click the picture to leave a note"
                    : "Select an element to edit"}
              </span>
              <button
                className="icon-button"
                aria-label="Focus editor"
                onClick={() => {
                  setNotebookVisible(false);
                  setChatVisible(false);
                }}
              >
                <ArrowsOutSimple />
              </button>
            </div>
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
          </section>
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
                attachmentResolve.current = resolve;
                setPicker("file");
              })
            }
          />
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
        <Modal title="New project" onClose={() => setDialog(null)}>
          <form
            className="project-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || creating) return;
              setCreating(true);
              setError("");
              void api("/projects", ProjectSchema, json("POST", { name }))
                .then(async (created) => {
                  await loadProjects();
                  openProject(created);
                  setName("");
                })
                .catch((error: unknown) =>
                  setError(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
                .finally(() => setCreating(false));
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
                onClick={() => setDialog(null)}
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
            <footer>Cutroom {status?.version ?? "0.1.0"}</footer>
          </div>
        </Modal>
      )}
      {picker && (
        <FileDialog
          kind={picker}
          initialPath={project?.path ?? status?.projectsDir ?? "/home"}
          onClose={() => {
            setPicker(null);
            attachmentResolve.current?.(null);
            attachmentResolve.current = null;
          }}
          onSelect={(path) => {
            const kind = picker;
            setPicker(null);
            if (kind === "file") {
              const resolve = attachmentResolve.current;
              attachmentResolve.current = null;
              void api(
                `/projects/${projectId}/attachments/import`,
                z.object({ path: z.string() }),
                json("POST", { path }),
              )
                .then((attachment) => resolve?.(attachment.path))
                .catch((error: unknown) => {
                  resolve?.(null);
                  setError(
                    error instanceof Error ? error.message : String(error),
                  );
                });
              return;
            }
            void api("/projects/import", ProjectSchema, json("POST", { path }))
              .then(async (imported) => {
                await loadProjects();
                openProject(imported);
              })
              .catch((error: unknown) =>
                setError(
                  error instanceof Error ? error.message : String(error),
                ),
              );
          }}
        />
      )}
    </div>
  );
}
