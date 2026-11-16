import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { z } from "zod";
import { protectedPath } from "../../../shared/sourcePaths";
import { subscribeProjectEvents } from "../../api";
import { openContextMenu, revealRows } from "../../components/ContextMenu";
import { showToast, useWorkspace } from "../../workspace";
import { inspectorSubject } from "../inspector/fields";
import { useTimeline } from "../timeline";
import {
  openFile,
  resolveOutside,
  revealClip,
  saveFile,
  startCode,
  useCode,
} from "./code";
import "./code.css";

const CodeEditor = lazy(() => import("./CodeEditor"));

const ListingSchema = z.object({ files: z.array(z.string()) });

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  files: string[];
}

/** Folders first, then files, each by name. */
function fileTree(paths: readonly string[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [] };
  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const parts = path.split("/");
    let folder = root;
    for (const name of parts.slice(0, -1)) {
      const at = folder.path ? `${folder.path}/${name}` : name;
      let next = folder.folders.find((child) => child.path === at);
      if (!next) {
        next = { name, path: at, folders: [], files: [] };
        folder.folders.push(next);
      }
      folder = next;
    }
    folder.files.push(path);
  }
  return root;
}

/** The project's files, read again when one appears or goes. */
function useProjectFiles(projectId: string, open: boolean) {
  const [files, setFiles] = useState<readonly string[]>([]);
  const listed = useRef(new Set<string>());
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closing = new AbortController();
    const load = () =>
      void fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        signal: closing.signal,
      })
        .then(async (response) => {
          if (!response.ok)
            throw new Error(
              `The project files could not load (${response.status}).`,
            );
          const { files } = ListingSchema.parse(await response.json());
          listed.current = new Set(files);
          setFiles(files);
        })
        .catch((error: unknown) => {
          if (!closing.signal.aborted)
            showToast(error instanceof Error ? error.message : String(error));
        });
    load();
    const stop = subscribeProjectEvents(projectId, "message", (event) => {
      const change = z
        .object({ changed: z.string(), version: z.string().nullable() })
        .safeParse(JSON.parse(String(event.data)));
      if (
        !change.success ||
        (change.data.version !== null) ===
          listed.current.has(change.data.changed)
      )
        return;
      // A copy or a move reports each file; one listing follows the burst.
      clearTimeout(timer);
      timer = setTimeout(load, 150);
    });
    return () => {
      closing.abort();
      clearTimeout(timer);
      stop();
    };
  }, [projectId, open]);
  return files;
}

function FolderRows({
  folder,
  current,
  edited,
  expanded,
  onToggle,
  onMenu,
}: {
  folder: Folder;
  current: string | undefined;
  edited: boolean;
  expanded: ReadonlySet<string>;
  onToggle(path: string, open: boolean): void;
  onMenu(event: MouseEvent<HTMLElement>, path: string): void;
}) {
  return (
    <ul>
      {folder.folders.map((child) => (
        <li key={child.path}>
          <details
            open={expanded.has(child.path)}
            onToggle={(event) => onToggle(child.path, event.currentTarget.open)}
          >
            <summary onContextMenu={(event) => onMenu(event, child.path)}>
              <CaretRight size={10} weight="bold" />
              {child.name}
            </summary>
            {expanded.has(child.path) && (
              <FolderRows
                folder={child}
                current={current}
                edited={edited}
                expanded={expanded}
                onToggle={onToggle}
                onMenu={onMenu}
              />
            )}
          </details>
        </li>
      ))}
      {folder.files.map((path) => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        return (
          <li key={path}>
            {protectedPath(path) ? (
              <span
                className="code-asset"
                onContextMenu={(event) => onMenu(event, path)}
              >
                {name}
              </span>
            ) : (
              <button
                aria-current={path === current ? "true" : undefined}
                data-edited={path === current && edited ? "" : undefined}
                onClick={() => void openFile(path)}
                onContextMenu={(event) => onMenu(event, path)}
              >
                {name}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The selected clip, by its id in the open composition, when one clip is the subject. */
function selectedClip() {
  const { view, selection, composition } = useTimeline.getState();
  const clip = view && inspectorSubject(view.timeline, selection)?.clip;
  return clip ? { composition, id: clip.id } : null;
}

/**
 * A file tree and a code editor left of the viewer. Saves go through the source writer with the
 * version they were loaded from, so a change made meanwhile by an agent or the timeline is a
 * conflict to resolve. It stays mounted while hidden, so closing it keeps unsaved edits.
 */
export function CodePanel({
  projectId,
  projectPath,
}: {
  projectId: string;
  /** The project folder, for copying a file's full path. */
  projectPath: string;
}) {
  const open = useWorkspace((state) => state.code);
  const file = useCode((state) => state.file);
  const edited = useCode((state) => state.edited);
  const saving = useCode((state) => state.saving);
  const outside = useCode((state) => state.outside);
  const files = useProjectFiles(projectId, open);
  const tree = useMemo(() => fileTree(files), [files]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState(open);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => startCode(projectId), [projectId]);
  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);
  // The open file's folders unfold, so the tree shows where it is.
  useEffect(() => {
    if (!file) return;
    const parts = file.path.split("/").slice(0, -1);
    const folders = parts.map((_, index) =>
      parts.slice(0, index + 1).join("/"),
    );
    setExpanded((current) =>
      folders.every((folder) => current.has(folder))
        ? current
        : new Set([...current, ...folders]),
    );
  }, [file?.path]);
  // While open, the panel shows the selected clip's element, or else the open composition.
  useEffect(() => {
    if (!open) return;
    let shown = "";
    const follow = () => {
      const clip = selectedClip();
      const key = clip ? `${clip.composition}\n${clip.id}` : "";
      if (key === shown) return;
      shown = key;
      if (clip) void revealClip(clip.composition, clip.id);
    };
    if (!selectedClip() && !useCode.getState().file)
      void openFile(useTimeline.getState().composition);
    follow();
    return useTimeline.subscribe((state, previous) => {
      if (
        state.selection !== previous.selection ||
        state.composition !== previous.composition
      )
        follow();
    });
  }, [open]);
  // Closing the panel from inside it hands the keyboard back to the timeline.
  useEffect(() => {
    if (open || !panel.current?.contains(document.activeElement)) return;
    document.querySelector<HTMLElement>(".edit-timeline")?.focus();
  }, [open]);

  const menu = (event: MouseEvent<HTMLElement>, path: string) =>
    openContextMenu(
      event,
      path,
      [
        {
          label: "Copy path",
          run: () =>
            void navigator.clipboard
              .writeText(`${projectPath}/${path}`)
              .catch(() => showToast("The path could not be copied.")),
        },
        ...revealRows(`${projectPath}/${path}`),
      ],
      event.currentTarget,
    );

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    const page = panel.current?.parentElement;
    if (!page || !event.currentTarget.hasPointerCapture(event.pointerId))
      return;
    const left = panel.current?.getBoundingClientRect().left ?? 0;
    page.style.setProperty(
      "--edit-code-width",
      `${Math.round(Math.max(0, event.clientX - left))}px`,
    );
  };

  return (
    <section
      ref={panel}
      id="code-panel"
      className="code-panel"
      aria-label="Code"
      data-open={open}
    >
      <nav className="code-files" aria-label="Project files">
        <FolderRows
          folder={tree}
          current={file?.path}
          edited={edited}
          expanded={expanded}
          onToggle={(path, isOpen) =>
            setExpanded((current) => {
              if (current.has(path) === isOpen) return current;
              const next = new Set(current);
              if (isOpen) next.add(path);
              else next.delete(path);
              return next;
            })
          }
          onMenu={menu}
        />
      </nav>
      <div className="code-file">
        {file && (
          <header>
            <span className="code-path" title={file.path}>
              {file.path}
            </span>
            {edited && <span className="code-edited">Edited</span>}
            <button
              className="code-save"
              disabled={!edited || saving}
              title="Save (Ctrl+S)"
              onClick={() => void saveFile()}
            >
              Save
            </button>
          </header>
        )}
        {outside && (
          <div className="code-outside" role="alert">
            <span>
              {outside.version === null
                ? "Deleted outside the code panel."
                : "Changed outside the code panel."}
            </span>
            <button onClick={() => resolveOutside("theirs")}>
              {outside.version === null ? "Discard" : "Reload"}
            </button>
            <button onClick={() => resolveOutside("mine")}>Save mine</button>
          </div>
        )}
        {loaded && (
          <Suspense fallback={null}>
            <CodeEditor />
          </Suspense>
        )}
      </div>
      <div
        className="code-split"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize code"
        onPointerDown={(event) =>
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        onPointerMove={resize}
      />
    </section>
  );
}
