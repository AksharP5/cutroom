import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FolderOpen, Plus } from "@phosphor-icons/react";
import { z } from "zod";
import { DuplicateJobSchema, ProjectSummarySchema } from "../../shared/project";
import type {
  DuplicateJob,
  Project,
  ProjectSummary,
} from "../../shared/project";
import { api, json } from "../api";
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

const DuplicatesSchema = z.object({ jobs: z.array(DuplicateJobSchema) });
const failed = (error: unknown) =>
  showToast(error instanceof Error ? error.message : String(error));
const copying = (job: DuplicateJob) =>
  ["queued", "running", "cancelling"].includes(job.state.status);

/** A copy still being made: its name and how far the copy has got, with Cancel as import has. */
function DuplicateTile({
  job,
  onCancel,
}: {
  job: DuplicateJob;
  onCancel: () => void;
}) {
  const { status, progress } = job.state;
  const percent = Math.floor(progress * 100);
  return (
    <div className="home-duplicate">
      <span className="home-well">
        <span className="home-frame" />
      </span>
      <span className="home-name">{job.name}</span>
      <span className="home-meta">
        <span role="status">
          {status === "cancelling"
            ? "Cancelling"
            : percent > 0 && percent < 100
              ? `Copying ${percent}%`
              : "Duplicating"}
        </span>
        {status === "running" && (
          <button className="text-button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </span>
    </div>
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
  onDuplicate,
  onRemove,
}: {
  project: Project;
  now: number;
  tabbable: boolean;
  onFocus: () => void;
  onOpen: () => void;
  onRename: (name: string) => Promise<void>;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const name = useId();
  const meta = useId();
  const [renaming, setRenaming] = useState(false);
  const tile = useRef<HTMLElement>(null);
  // Focus returns to the tile once it is a button again; the field it replaces took focus with it.
  const refocus = useRef(false);
  useEffect(() => {
    if (renaming || !refocus.current) return;
    refocus.current = false;
    tile.current?.focus();
  }, [renaming]);
  // Compositions are read and frames rendered only for tiles that have been on screen.
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
            refocus.current = true;
            setRenaming(false);
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
      data-project={project.id}
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
            { label: "Duplicate", run: onDuplicate },
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
  onDuplicated,
  onRemove,
}: {
  projects: Project[];
  onOpen: (project: Project) => void;
  onCreate: () => void;
  onImport: () => void;
  onRename: (project: Project, name: string) => Promise<void>;
  /** A copy is on the list; resolves once the list shows it. */
  onDuplicated: () => Promise<unknown>;
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
  // A new copy takes the selection, as a duplicated clip does.
  const select = useRef<string | null>(null);
  useEffect(() => {
    const copy = select.current;
    select.current = null;
    if (copy)
      grid.current
        ?.querySelector<HTMLElement>(`[data-project="${copy}"]`)
        ?.focus();
    const index = refocus.current;
    if (index === null) return;
    refocus.current = null;
    const tiles = grid.current?.querySelectorAll<HTMLElement>(".home-project");
    tiles?.[Math.min(index, tiles.length - 1)]?.focus();
  }, [projects]);

  // Copies in progress, including ones an agent started. Polled only while one is running.
  const [duplicates, setDuplicates] = useState<DuplicateJob[]>([]);
  const watching = useRef(new Set<string>());
  const poll = useCallback(async () => {
    const { jobs } = await api("/duplicates", DuplicatesSchema);
    for (const job of jobs) {
      if (copying(job)) {
        watching.current.add(job.id);
        continue;
      }
      if (!watching.current.delete(job.id)) continue;
      if (job.state.status === "failed") showToast(job.state.error);
      if (job.state.status !== "done") continue;
      select.current = job.projectId ?? null;
      await onDuplicated();
    }
    setDuplicates(jobs.filter(copying));
  }, [onDuplicated]);
  useEffect(() => void poll().catch(failed), [poll]);
  useEffect(() => {
    if (!duplicates.length) return;
    const timer = setTimeout(() => void poll().catch(failed), 200);
    return () => clearTimeout(timer);
  }, [duplicates, poll]);
  const duplicate = (project: Project) =>
    void api(
      `/projects/${encodeURIComponent(project.id)}/duplicate`,
      DuplicateJobSchema,
      json("POST"),
    )
      .then((job) => {
        watching.current.add(job.id);
        setDuplicates((current) => [...current, job]);
      })
      .catch(failed);
  const cancel = (job: DuplicateJob) =>
    void api(
      `/duplicates/${encodeURIComponent(job.id)}/cancel`,
      DuplicateJobSchema,
      json("POST"),
    )
      .then((next) =>
        setDuplicates((current) =>
          current.map((item) => (item.id === next.id ? next : item)),
        ),
      )
      .catch(failed);

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
        {duplicates.map((job) => (
          <li key={job.id}>
            <DuplicateTile job={job} onCancel={() => cancel(job)} />
          </li>
        ))}
        {projects.map((project, index) => (
          <li key={project.id}>
            <ProjectTile
              project={project}
              now={now}
              tabbable={project.id === tabbable}
              onFocus={() => setActive(project.id)}
              onOpen={() => onOpen(project)}
              onRename={(name) => onRename(project, name)}
              onDuplicate={() => duplicate(project)}
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
