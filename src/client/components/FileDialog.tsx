import { useEffect, useState } from "react";
import { ArrowUp, File, Folder, FolderOpen } from "@phosphor-icons/react";
import { z } from "zod";
import { api } from "../api";
import { Modal } from "./Modal";

const directorySchema = z.object({
  path: z.string(),
  parent: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      directory: z.boolean(),
      size: z.number(),
    }),
  ),
});
type DirectoryState =
  | { status: "loading"; path: string }
  | {
      status: "ready";
      path: string;
      directory: z.infer<typeof directorySchema>;
    }
  | { status: "failed"; path: string; message: string };

const titles = {
  file: "Attach a file",
  directory: "Open a project folder",
  project: "Project files",
} as const;
const actions = {
  file: "Attach file",
  directory: "Open this folder",
  project: "Copy path",
} as const;

export function FileDialog({
  initialPath,
  kind,
  onSelect,
  onClose,
}: {
  initialPath: string;
  /** `project` browses a project's folder and copies the chosen file's path. */
  kind: "file" | "directory" | "project";
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [input, setInput] = useState(initialPath);
  const [directoryState, setDirectoryState] = useState<DirectoryState>({
    status: "loading",
    path: initialPath,
  });
  const current = directoryState.path === path ? directoryState : null;
  const directory = current?.status === "ready" ? current.directory : null;
  const loading = current === null || current.status === "loading";
  const error = current?.status === "failed" ? current.message : "";
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDirectoryState({ status: "loading", path });
    setSelected(null);
    void api(`/browse?path=${encodeURIComponent(path)}`, directorySchema)
      .then((result) => {
        if (!cancelled) {
          setDirectoryState({ status: "ready", path, directory: result });
          setInput(result.path);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setDirectoryState({
            status: "failed",
            path,
            message: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <Modal title={titles[kind]} onClose={onClose} wide>
      <form
        className="file-location"
        onSubmit={(event) => {
          event.preventDefault();
          setPath(input);
        }}
      >
        <button
          className="icon-button"
          type="button"
          aria-label="Parent folder"
          disabled={
            !directory || directory.path === directory.parent || loading
          }
          onClick={() => directory && setPath(directory.parent)}
        >
          <ArrowUp />
        </button>
        <input
          aria-label="Folder path"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button className="secondary-button">Go</button>
      </form>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div
        className="file-list"
        aria-label="Files and folders"
        aria-busy={loading}
      >
        {loading && !directory && (
          <p className="quiet-message">Reading folder…</p>
        )}
        {directory?.entries
          .filter((entry) => kind !== "directory" || entry.directory)
          .map((entry) => (
            <button
              key={entry.path}
              disabled={loading}
              className={`file-row ${selected === entry.path ? "selected" : ""}`}
              onClick={() =>
                entry.directory ? setPath(entry.path) : setSelected(entry.path)
              }
              onDoubleClick={() => !entry.directory && onSelect(entry.path)}
            >
              {entry.directory ? <Folder size={18} /> : <File size={18} />}
              <span>{entry.name}</span>
              {!entry.directory && (
                <small>
                  {entry.size < 1_000_000
                    ? `${Math.round(entry.size / 1000)} KB`
                    : `${(entry.size / 1_000_000).toFixed(1)} MB`}
                </small>
              )}
            </button>
          ))}
        {directory?.entries.length === 0 && !loading && (
          <p className="quiet-message">This folder is empty.</p>
        )}
      </div>
      <footer className="modal-actions">
        <button className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={
            loading || !directory || (kind !== "directory" && !selected)
          }
          onClick={() => {
            const value = kind === "directory" ? directory?.path : selected;
            if (value) onSelect(value);
          }}
        >
          <FolderOpen />
          {actions[kind]}
        </button>
      </footer>
    </Modal>
  );
}
