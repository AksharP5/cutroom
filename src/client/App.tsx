import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CaretDown,
  Check,
  FolderOpen,
  Folders,
  GearSix,
  Plus,
} from "@phosphor-icons/react";
import { z } from "zod";
import { ProjectSchema, type Project } from "../shared/project";
import {
  NotebookSchema,
  REVIEW_STATE_PATH,
  ReviewItemSchema,
  type Notebook,
} from "../shared/review";
import type {
  EditorContext,
  EditorMode,
  EditorReviewDraft,
} from "../shared/editor";
import { api, json } from "./api";
import { toFrames } from "../shared/timeline/apply";
import { version } from "../shared/version";
import { ChatPanel } from "./components/ChatPanel";
import { EmptyState } from "./components/EmptyState";
import { FileDialog } from "./components/FileDialog";
import { Logo } from "./components/Logo";
import { MediaPanel } from "./components/MediaPanel";
import { Modal } from "./components/Modal";
import { ReviewPanel } from "./components/ReviewPanel";
import { saveReviewNote } from "./review";
import { EditorToolsContext } from "./editor/EditorTools";
import { ScriptPanel } from "./components/ScriptPanel";
import { StatusBar } from "./components/StatusBar";
import { useWorkspace } from "./workspace";

const Editor = lazy(() =>
  import("./editor/CutroomEditor").then((module) => ({
    default: module.CutroomEditor,
  })),
);
const EditPage = lazy(() =>
  import("./edit/EditPage").then((module) => ({ default: module.EditPage })),
);
const projectsSchema = z.object({ projects: z.array(ProjectSchema) });
const statusSchema = z.object({
  version: z.string(),
  projectsDir: z.string(),
  dataDir: z.string(),
  mcpCommand: z.string(),
});
const emptyDocument: Notebook = { items: [], transcriptVersion: "" };

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
    document: Notebook;
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
  const newEditor = useWorkspace((state) => state.newEditor);
  const newNotes = projectDocument.items.filter(
    (item) => item.review.status === "open",
  );
  // The Review badge counts notes that wait on you: unsent, done, or asking.
  const waiting = projectDocument.items.filter((item) =>
    ["open", "done", "blocked"].includes(item.review.status),
  ).length;
  const workingIndex = projectDocument.items.findIndex(
    (item) => item.review.status === "working",
  );
  const tabs = useRef<HTMLElement>(null);
  const lastPanel = useRef<"agent" | "notebook">("agent");
  const indicator = useRef<HTMLSpanElement>(null);
  const activeTab = chatVisible ? 0 : panel === "review" ? 1 : 2;
  const [dialog, setDialog] = useState<
    "projects" | "create" | "settings" | null
  >(null);
  const [picker, setPicker] = useState<"file" | "directory" | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [toastLeaving, setToastLeaving] = useState(false);
  useEffect(() => setToastLeaving(false), [error]);
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

  // The tab indicator moves and resizes with transform only.
  useLayoutEffect(() => {
    const nav = tabs.current;
    const bar = indicator.current;
    if (!nav || !bar || !workPanel) return;
    const place = () => {
      const tab = nav.querySelectorAll("button")[activeTab];
      if (!tab) return;
      // The bar spans the label, inside the padding that keeps the focus ring clear.
      const inset = parseFloat(getComputedStyle(tab).paddingLeft);
      bar.style.transform = `translateX(${tab.offsetLeft + inset}px) scaleX(${(tab.offsetWidth - inset * 2) / 100})`;
    };
    place();
    const ready = requestAnimationFrame(() => (bar.dataset.ready = ""));
    void document.fonts.ready.then(place);
    return () => cancelAnimationFrame(ready);
  }, [activeTab, workPanel, project?.id, waiting]);

  const loadProjects = useCallback(async () => {
    const request = ++projectListRequest.current;
    const result = await api("/projects", projectsSchema);
    if (request === projectListRequest.current) setProjects(result.projects);
    return result.projects;
  }, []);
  const refreshDocument = useCallback(async () => {
    if (!projectId) return;
    const request = ++documentRequest.current;
    const result = await api(`/projects/${projectId}/notebook`, NotebookSchema);
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
        else if (
          payload.changed !== "cutroom.json" &&
          payload.changed !== REVIEW_STATE_PATH
        ) {
          useWorkspace.setState((state) => ({
            mediaRevision: state.mediaRevision + 1,
            fileChanges: {
              ...state.fileChanges,
              [payload.changed]: Date.now(),
            },
          }));
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
      if (event.key === "Escape") {
        setMode("select");
        setReviewState(null);
      }
      // Cutroom's own editor binds its tools in its keymap.
      if (useWorkspace.getState().newEditor) return;
      const modes = { v: "select", d: "draw", c: "comment" } as const;
      const pressed = event.key.toLowerCase();
      if (pressed === "v" || pressed === "d" || pressed === "c") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setMode(modes[pressed]);
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
    if (useWorkspace.getState().newEditor) {
      const { transport, useTransport } = await import("./edit/transport");
      if (activeProjectId.current === expectedProject)
        transport.seek(toFrames(time, useTransport.getState().fps));
      return;
    }
    const { seekEditor } = await import("./editor/CutroomEditor");
    if (activeProjectId.current === expectedProject)
      seekEditor(time, compositionPath);
  }, []);
  const changed = useCallback(async () => {
    await refreshDocument();
    // Cutroom's own editor reloads from the project's change events.
    if (
      activeProjectId.current !== projectId ||
      useWorkspace.getState().newEditor
    )
      return;
    const { refreshEditor } = await import("./editor/CutroomEditor");
    refreshEditor();
  }, [projectId, refreshDocument]);
  // The server adds the review queue digest to each message.
  function getContext() {
    return JSON.stringify(
      {
        project: project ? { name: project.name, path: project.path } : null,
        editor: context.current,
      },
      null,
      2,
    );
  }

  return (
    <div className="cutroom-app">
      <header className="app-header">
        <div className="header-start">
          <button
            className="logo-button"
            aria-label="Cutroom projects"
            onClick={() => setDialog("projects")}
          >
            <Logo />
          </button>
          <span className="header-divider" />
          <button
            className="project-switcher"
            onClick={() => setDialog("projects")}
          >
            <span>{project?.name ?? "Projects"}</span>
            <CaretDown size={10} weight="bold" />
          </button>
        </div>
        <div className="toast-slot">
          {error && (
            <div
              className="toast"
              data-tone="error"
              data-leaving={toastLeaving || undefined}
              role="alert"
              onTransitionEnd={(event) => {
                if (toastLeaving && event.propertyName === "opacity") {
                  setToastLeaving(false);
                  setError("");
                }
              }}
            >
              <span title={error}>{error}</span>
              <button onClick={() => setToastLeaving(true)}>Dismiss</button>
            </div>
          )}
        </div>
        <div className="header-end">
          <button
            className="icon-button"
            aria-label="Settings"
            onClick={() => setDialog("settings")}
          >
            <GearSix />
          </button>
        </div>
      </header>
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
            hidden={!workPanel}
          />
          <section
            className="work-panel"
            aria-label="Project workspace"
            hidden={!workPanel}
          >
            <nav
              className="workspace-tabs"
              aria-label="Workspace panels"
              ref={tabs}
            >
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
                {waiting > 0 && <span className="note-count">{waiting}</span>}
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
              <span className="tab-indicator" ref={indicator} />
            </nav>
            <aside
              key={`notebook:${project.id}`}
              className="notebook"
              hidden={!notebookVisible}
            >
              <div className="notebook-content">
                <div hidden={panel !== "review"}>
                  <ReviewPanel
                    key={project.id}
                    projectId={project.id}
                    items={projectDocument.items}
                    reviewError={projectDocument.reviewError}
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
                    onSeek={(item) =>
                      void seek(item.time, item.compositionPath)
                    }
                    onAct={async (item, action) => {
                      await api(
                        `/projects/${projectId}/review/${item.id}/human`,
                        ReviewItemSchema,
                        json("POST", action),
                      );
                      await refreshDocument();
                    }}
                    onDelete={async (item) => {
                      await api(
                        `/projects/${projectId}/annotations/${item.id}`,
                        z.unknown(),
                        json("DELETE"),
                      );
                      await refreshDocument();
                    }}
                    onSend={() =>
                      ask(
                        `Apply my ${newNotes.length} pending review notes. They are included with this message's project context.`,
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
                newNotes.flatMap((note) =>
                  note.framePath ? [note.framePath] : [],
                )
              }
              onSent={() =>
                void refreshDocument().catch((error: unknown) =>
                  setError(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
              }
              prompt={prompt}
              onPromptConsumed={consumePrompt}
              workingNote={workingIndex < 0 ? null : workingIndex + 1}
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
              value={{
                mode,
                setMode,
                focused: !workPanel,
                focusEditor: () =>
                  setWorkPanel((value) => {
                    if (value) lastPanel.current = value;
                    return value ? null : lastPanel.current;
                  }),
              }}
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
                  {newEditor ? (
                    <EditPage
                      projectId={project.id}
                      onContext={onContext}
                      onReview={onReview}
                    />
                  ) : (
                    <Editor
                      projectId={project.id}
                      mode={mode}
                      onContext={onContext}
                      onReview={onReview}
                      onAskAgent={ask}
                    />
                  )}
                </Suspense>
              </EditorBoundary>
            </EditorToolsContext.Provider>
          </section>
          <StatusBar
            project={project}
            items={projectDocument.items}
            onReview={() => {
              setPanel("review");
              setWorkPanel("notebook");
            }}
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
              <h3>Editor</h3>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={newEditor}
                  onChange={(event) =>
                    useWorkspace.setState({ newEditor: event.target.checked })
                  }
                />
                New editor
              </label>
              <p>Cutroom's own viewer and transport, in progress.</p>
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
