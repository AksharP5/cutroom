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

export function FileDialog({
  initialPath,
  kind,
  onSelect,
  onClose,
}: {
  initialPath: string;
  kind: "file" | "directory";
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [input, setInput] = useState(initialPath);
  const [directory, setDirectory] = useState<z.infer<
    typeof directorySchema
  > | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setSelected(null);
    void api(`/browse?path=${encodeURIComponent(path)}`, directorySchema)
      .then((result) => {
        if (!cancelled) {
          setDirectory(result);
          setInput(result.path);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <Modal
      title={kind === "directory" ? "Open a project folder" : "Attach a file"}
      onClose={onClose}
      wide
    >
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
          .filter((entry) => kind === "file" || entry.directory)
          .map((entry) => (
            <button
              key={entry.path}
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
          disabled={loading || (kind === "file" ? !selected : !directory)}
          onClick={() => {
            const value = kind === "file" ? selected : directory?.path;
            if (value) onSelect(value);
          }}
        >
          <FolderOpen />
          {kind === "directory" ? "Open this folder" : "Attach file"}
        </button>
      </footer>
    </Modal>
  );
}
