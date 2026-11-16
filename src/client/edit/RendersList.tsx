import { useEffect, useState } from "react";
import type { RenderFile } from "../../shared/export";
import { deleteRender, listRenders } from "./export";

const formatNames: Record<RenderFile["format"], string> = {
  mp4: "MP4",
  mov: "MOV",
  webm: "WebM",
  gif: "GIF",
};

export const formatBytes = (bytes: number) =>
  new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: bytes >= 1_000_000 ? "megabyte" : "kilobyte",
    maximumFractionDigits: 1,
  }).format(bytes / (bytes >= 1_000_000 ? 1_000_000 : 1_000));

const when = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** The project's past renders, wherever they were saved, to open, show or delete. */
export function RendersList({ projectId }: { projectId: string }) {
  const [renders, setRenders] = useState<RenderFile[]>([]);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let current = true;
    void listRenders(projectId).then(
      (renders) => {
        if (current) setRenders(renders);
      },
      (error: unknown) => {
        if (current)
          setError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      current = false;
    };
  }, [projectId, loads]);
  const act = (task: Promise<unknown>) => {
    setError("");
    void task.then(
      () => setLoads((count) => count + 1),
      (error: unknown) =>
        setError(error instanceof Error ? error.message : String(error)),
    );
  };
  if (!renders.length && !error) return null;
  const desktop = window.cutroomDesktop;
  return (
    <section className="export-renders" aria-label="Renders">
      <h3>Renders</h3>
      <ul>
        {renders.map((render) => {
          const name = render.path.split(/[/\\]/).at(-1) ?? render.path;
          return (
            <li key={render.path}>
              <div className="export-render-file" title={render.path}>
                <span className="export-render-name">{name}</span>
                <span className="export-render-meta">
                  {formatNames[render.format]} · {formatBytes(render.sizeBytes)}{" "}
                  · {when.format(render.modifiedAt)}
                </span>
              </div>
              {confirming === render.path ? (
                <div className="export-render-actions">
                  <button
                    className="secondary-button export-render-delete"
                    onClick={() => {
                      setConfirming(null);
                      act(deleteRender(projectId, render.path));
                    }}
                  >
                    Delete file
                  </button>
                  <button
                    className="secondary-button"
                    autoFocus
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <div className="export-render-actions">
                  {desktop ? (
                    <>
                      <button
                        className="secondary-button"
                        onClick={() =>
                          act(desktop.exportFile(render.path, "reveal"))
                        }
                      >
                        Reveal
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() =>
                          act(desktop.exportFile(render.path, "open"))
                        }
                      >
                        Open
                      </button>
                    </>
                  ) : (
                    <a
                      className="secondary-button"
                      href={`/api/projects/${encodeURIComponent(projectId)}/exports/file?${new URLSearchParams({ path: render.path })}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open
                    </a>
                  )}
                  <button
                    className="secondary-button"
                    aria-label={`Delete ${name}`}
                    onClick={() => setConfirming(render.path)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="export-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
