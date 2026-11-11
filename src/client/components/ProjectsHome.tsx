import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, Plus } from "@phosphor-icons/react";
import { ProjectSummarySchema } from "../../shared/project";
import type { Project, ProjectSummary } from "../../shared/project";
import { api } from "../api";
import {
  aspectLabel,
  durationLabel,
  editedLabel,
  gridStep,
  posterUrl,
} from "../home";
import "./home.css";

/** A capture still rendering must not hold a connection the editor needs once its tile is gone. */
const cancelWhenRemoved = (image: HTMLImageElement) => () =>
  image.removeAttribute("src");

/** One project: its poster frame, name, length, shape, and when it was last edited. */
function ProjectTile({
  project,
  now,
  tabbable,
  onFocus,
  onOpen,
}: {
  project: Project;
  now: number;
  tabbable: boolean;
  onFocus: () => void;
  onOpen: () => void;
}) {
  const name = useId();
  const meta = useId();
  // Compositions are read and frames rendered only for tiles that have been on screen.
  const tile = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = tile.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setSeen(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);

  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [unreadable, setUnreadable] = useState("");
  const [poster, setPoster] = useState<"pending" | "ready" | "missing">(
    "pending",
  );
  useEffect(() => {
    if (!seen) return;
    const closing = new AbortController();
    void api(`/projects/${project.id}/summary`, ProjectSummarySchema, {
      signal: closing.signal,
    })
      .then((value) => {
        setSummary(value);
        setUnreadable("");
      })
      .catch((error: unknown) => {
        if (closing.signal.aborted) return;
        setSummary(null);
        setUnreadable(error instanceof Error ? error.message : String(error));
      });
    return () => closing.abort();
  }, [seen, project.id, project.updatedAt]);

  return (
    <button
      ref={tile}
      className="home-project"
      title={project.path}
      aria-labelledby={name}
      aria-describedby={meta}
      tabIndex={tabbable ? 0 : -1}
      data-poster={unreadable ? "missing" : seen ? poster : undefined}
      onFocus={onFocus}
      onClick={onOpen}
    >
      <span className="home-well">
        <span
          className="home-frame"
          style={
            summary
              ? {
                  // A frame taller than the well is narrowed until it fits.
                  width: `${Math.min(1, (summary.width * 9) / (summary.height * 16)) * 100}%`,
                  aspectRatio: `${summary.width} / ${summary.height}`,
                }
              : undefined
          }
        >
          {summary && (
            <img
              ref={cancelWhenRemoved}
              src={posterUrl(project, summary)}
              alt=""
              draggable={false}
              onLoad={() => setPoster("ready")}
              onError={() => setPoster("missing")}
            />
          )}
        </span>
        <span className="home-selection" />
      </span>
      <span className="home-name" id={name}>
        {project.name}
      </span>
      <span className="home-meta" id={meta}>
        {summary && (
          <>
            <span className="mono">{durationLabel(summary.duration)}</span>
            <span className="mono">
              {aspectLabel(summary.width, summary.height)}
            </span>
          </>
        )}
        {unreadable && (
          <span className="home-unreadable" title={unreadable}>
            {unreadable}
          </span>
        )}
        <time dateTime={project.updatedAt}>
          {editedLabel(project.updatedAt, now)}
        </time>
      </span>
    </button>
  );
}

/** Home once a project exists: every project as a frame, most recently edited first. */
export function ProjectsHome({
  projects,
  onOpen,
  onCreate,
  onImport,
}: {
  projects: Project[];
  onOpen: (project: Project) => void;
  onCreate: () => void;
  onImport: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);

  // One tile is in the tab order; arrow keys move between tiles.
  const grid = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState<string>();
  const tabbable = projects.some((project) => project.id === active)
    ? active
    : projects[0]?.id;
  // The most recent project is one Enter away.
  useEffect(() => grid.current?.querySelector("button")?.focus(), []);

  return (
    <main className="home">
      <header className="home-head">
        <h1>Projects</h1>
        <div className="home-actions">
          <button className="secondary-button" onClick={onImport}>
            <FolderOpen />
            Open folder
          </button>
          <button className="primary-button" onClick={onCreate}>
            <Plus />
            New project
          </button>
        </div>
      </header>
      <ul
        ref={grid}
        className="home-grid"
        aria-label="Projects"
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          const tiles = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              ".home-project",
            ),
          ];
          const index = tiles.findIndex((tile) => tile === event.target);
          if (index < 0) return;
          const top = tiles[0]?.getBoundingClientRect().top;
          const columns = tiles.filter(
            (tile) => tile.getBoundingClientRect().top === top,
          ).length;
          const next = gridStep(event.key, index, columns, tiles.length);
          if (next === null) return;
          event.preventDefault();
          tiles[next]?.focus();
        }}
      >
        {projects.map((project) => (
          <li key={project.id}>
            <ProjectTile
              project={project}
              now={now}
              tabbable={project.id === tabbable}
              onFocus={() => setActive(project.id)}
              onOpen={() => onOpen(project)}
            />
          </li>
        ))}
      </ul>
    </main>
  );
}
