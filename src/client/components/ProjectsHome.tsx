import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
import { showToast } from "../workspace";
import { openContextMenu, revealRows } from "./ContextMenu";
import { Logo } from "./Logo";
import "./home.css";

/** A capture still rendering must not hold a connection the editor needs once its tile is gone. */
const cancelWhenRemoved = (image: HTMLImageElement) => () =>
  image.removeAttribute("src");

/** The name being typed over a tile's name. Enter or leaving the field saves it; Esc keeps the old one. */
function RenameField({
  project,
  onRename,
  onDone,
}: {
  project: Project;
  onRename: (name: string) => Promise<void>;
  onDone: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const ended = useRef(false);
  useLayoutEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const finish = async (save: boolean) => {
    if (ended.current || saving) return;
    const name = value.trim();
    if (!save || !name || name === project.name) {
      ended.current = true;
      onDone();
      return;
    }
    setSaving(true);
    try {
      await onRename(name);
      ended.current = true;
      onDone();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
      field.current?.focus();
    } finally {
      setSaving(false);
    }
  };
  return (
    <input
      ref={field}
      className="home-name home-rename"
      aria-label="Project name"
      maxLength={120}
      value={value}
      readOnly={saving}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => void finish(true)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          void finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          void finish(false);
        }
      }}
    />
  );
}

/** One project: its poster frame, name, length, shape, and when it was last edited. */
function ProjectTile({
  project,
  now,
  tabbable,
  onFocus,
  onOpen,
  onRename,
  onRemove,
}: {
  project: Project;
  now: number;
  tabbable: boolean;
  onFocus: () => void;
  onOpen: () => void;
  onRename: (name: string) => Promise<void>;
  onRemove: () => void;
}) {
  const name = useId();
  const meta = useId();
  const [renaming, setRenaming] = useState(false);
  // Compositions are read and frames rendered only for tiles that have been on screen.
  const tile = useRef<HTMLElement>(null);
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
  const [posterState, setPoster] = useState<"pending" | "ready" | "missing">(
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

  const empty = summary?.duration === 0;
  const poster = unreadable
    ? "missing"
    : empty
      ? "empty"
      : seen
        ? posterState
        : undefined;
  const contents = (
    <>
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
          {empty ? (
            <Logo markOnly />
          ) : (
            summary && (
              <img
                ref={cancelWhenRemoved}
                src={posterUrl(project, summary)}
                alt=""
                draggable={false}
                onLoad={() => setPoster("ready")}
                onError={() => setPoster("missing")}
              />
            )
          )}
        </span>
        <span className="home-selection" />
      </span>
      {renaming ? (
        <RenameField
          project={project}
          onRename={onRename}
          onDone={() => {
            setRenaming(false);
            requestAnimationFrame(() => tile.current?.focus());
          }}
        />
      ) : (
        <span className="home-name" id={name}>
          {project.name}
        </span>
      )}
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
    </>
  );
  // A field cannot sit inside a button, so the tile stops being one while its name is typed.
  if (renaming)
    return (
      <div
        ref={(element) => {
          tile.current = element;
        }}
        className="home-project"
        data-poster={poster}
        data-renaming
      >
        {contents}
      </div>
    );
  return (
    <button
      ref={(element) => {
        tile.current = element;
      }}
      className="home-project"
      title={project.path}
      aria-labelledby={name}
      aria-describedby={meta}
      tabIndex={tabbable ? 0 : -1}
      data-poster={poster}
      onFocus={onFocus}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "F2" || event.altKey || event.ctrlKey) return;
        event.preventDefault();
        setRenaming(true);
      }}
      onContextMenu={(event) =>
        openContextMenu(
          event,
          project.name,
          [
            { label: "Open", run: onOpen },
            "separator",
            { label: "Rename", keys: "F2", run: () => setRenaming(true) },
            ...revealRows(project.path),
            "separator",
            { label: "Remove from list", run: onRemove },
          ],
          event.currentTarget,
        )
      }
    >
      {contents}
    </button>
  );
}

/** Home once a project exists: every project as a frame, most recently edited first. */
export function ProjectsHome({
  projects,
  onOpen,
  onCreate,
  onImport,
  onRename,
  onRemove,
}: {
  projects: Project[];
  onOpen: (project: Project) => void;
  onCreate: () => void;
  onImport: () => void;
  onRename: (project: Project, name: string) => Promise<void>;
  /** Resolves true once the project has left the list. */
  onRemove: (project: Project) => Promise<boolean>;
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
  // A removed tile hands focus to the one that takes its place.
  const refocus = useRef<number | null>(null);
  useEffect(() => {
    const index = refocus.current;
    if (index === null) return;
    refocus.current = null;
    const tiles = grid.current?.querySelectorAll<HTMLElement>(".home-project");
    tiles?.[Math.min(index, tiles.length - 1)]?.focus();
  }, [projects]);

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
        {projects.map((project, index) => (
          <li key={project.id}>
            <ProjectTile
              project={project}
              now={now}
              tabbable={project.id === tabbable}
              onFocus={() => setActive(project.id)}
              onOpen={() => onOpen(project)}
              onRename={(name) => onRename(project, name)}
              onRemove={() => {
                refocus.current = index;
                void onRemove(project).then((removed) => {
                  if (!removed) refocus.current = null;
                });
              }}
            />
          </li>
        ))}
      </ul>
    </main>
  );
}
