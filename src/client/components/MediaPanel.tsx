import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { MagnifyingGlass, Plus, Waveform } from "@phosphor-icons/react";
import { z } from "zod";
import {
  MEDIA_TRASH,
  mediaKind,
  mediaKinds,
  mediaSearch,
  previewMediaPath,
} from "../../shared/media";
import type { TimelineView } from "../../shared/timeline/schema";
import { api, frameTimecode, json, mediaUrl } from "../api";
import { useOfflineMedia } from "../edit/offlineMedia";
import { placeAtPlayhead } from "../edit/placeMedia";
import { closeSource, openSource, useSource } from "../edit/source";
import { stepHistory, useTimeline } from "../edit/timeline";
import { gridStep } from "../home";
import {
  actionFor,
  focusByKeyboard,
  reachedByKeyboard,
  useKeymap,
} from "../keymap";
import {
  MEDIA_DRAG_TYPE,
  STILL_SECONDS,
  setMediaDrag,
} from "../timeline/mediaDrag";
import type { MediaDrag } from "../timeline/mediaDrag";
import { showToast, useFps, useWorkspace } from "../workspace";
import { TimecodeText } from "./TimecodeText";
import { openContextMenu, revealRows } from "./ContextMenu";
import { Modal } from "./Modal";
import { CompositionList, useCompositions } from "./CompositionList";

const acceptedFiles = mediaKinds
  .flatMap(({ extensions }) => extensions.map((extension) => `.${extension}`))
  .join(",");
const UPLOAD_BYTES = 500 * 1024 * 1024;
const STILL_IMPORTING =
  "Still importing. Drop the next files when it finishes.";
const UPLOAD_LIMIT =
  "Imports are limited to 500 MB at a time. Copy larger files into the project folder and they will appear here.";

const projectFilesSchema = z.object({
  files: z.array(z.string()),
  fileVersions: z.record(z.string(), z.string().nullable()),
});
const uploadSchema = z.object({
  files: z.array(z.string()),
  skipped: z.array(z.string()).default([]),
  invalid: z
    .array(z.object({ name: z.string(), reason: z.string() }))
    .default([]),
});

const fileName = (path: string) => path.split("/").at(-1) ?? path;

function focusMediaRow(element: HTMLElement | null | undefined) {
  focusByKeyboard(element);
  element?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** The name in place of the row's label. The extension stays: a rename never converts a file. */
function RenameField({
  name,
  onCommit,
  onCancel,
}: {
  name: string;
  /** Resolves false when the name was refused and the field stays open to correct it. */
  onCommit(stem: string, by: "key" | "blur"): Promise<boolean>;
  onCancel(): void;
}) {
  const extension = name.slice(name.lastIndexOf("."));
  const stem = name.slice(0, -extension.length);
  const input = useRef<HTMLInputElement>(null);
  /** Enter or Escape answered; the blur that follows is not a second answer. */
  const settled = useRef(false);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);
  const settle = (value: string, by: "key" | "blur") => {
    settled.current = true;
    const next = value.trim();
    if (!next || next === stem) return onCancel();
    void onCommit(next, by).then((done) => (settled.current = done));
  };
  return (
    <span className="media-name media-rename">
      <input
        ref={input}
        aria-label={`Rename ${name}`}
        defaultValue={stem}
        spellCheck={false}
        autoComplete="off"
        onKeyDown={(event) => {
          // Typing a name never opens, removes, or moves through the rows.
          event.stopPropagation();
          if (event.key === "Enter") settle(event.currentTarget.value, "key");
          if (event.key === "Escape") settle(stem, "key");
        }}
        onBlur={(event) => {
          if (!settled.current) settle(event.currentTarget.value, "blur");
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      />
      <span>{extension}</span>
    </span>
  );
}

// Every row selects one number, so a timeline edit only renders the rows whose counts changed.
const usedMediaByTimeline = new WeakMap<
  TimelineView,
  {
    files: ReturnType<typeof useWorkspace.getState>["fileChanges"];
    counts: ReadonlyMap<string, number>;
  }
>();

function usedMediaCount(view: TimelineView, name: string) {
  const files = useWorkspace.getState().fileChanges;
  const cached = usedMediaByTimeline.get(view);
  if (cached?.files === files) return cached.counts.get(name) ?? 0;

  const counts = new Map<string, number>();
  for (const clip of view.timeline.clips) {
    if (!clip.src) continue;
    const path = previewMediaPath(view.composition, clip.src, files);
    if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  usedMediaByTimeline.set(view, { files, counts });
  return counts.get(name) ?? 0;
}

/** One row: a thumbnail, the file name, and its length read from the file itself. */
function MediaRow({
  projectId,
  projectPath,
  path,
  kind,
  offline,
  tabbable,
  onFocus,
  renaming,
  onRename,
  onRenameCommit,
  onRenameCancel,
  onRemove,
}: {
  projectId: string;
  /** The project's folder on disk, for the desktop's file manager. */
  projectPath: string;
  path: string;
  kind: (typeof mediaKinds)[number]["kind"];
  offline: boolean;
  /** One row is in the tab order; the arrow keys move between rows. */
  tabbable: boolean;
  onFocus(): void;
  renaming: boolean;
  onRename(): void;
  /** The new name without its extension; `key` when Enter asked for it. */
  onRenameCommit(stem: string, by: "key" | "blur"): Promise<boolean>;
  onRenameCancel(): void;
  onRemove(): void;
}) {
  const fps = useFps();
  const uses = useTimeline((state) =>
    state.projectId === projectId && state.view
      ? usedMediaCount(state.view, path)
      : 0,
  );
  const [duration, setDuration] = useState<number | null>(null);
  const [hasAudio, setHasAudio] = useState<boolean | null>(null);
  // Decoders start only for rows that have been on screen.
  const row = useRef<HTMLLIElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = row.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  const changed = useWorkspace((state) => state.fileChanges[path]);
  // The file left this name, by a rename or a move, before the list read it again: asking for
  // it now would only show a broken picture until the row goes.
  const gone = offline || changed === null;
  useEffect(() => setDuration(null), [changed]);
  useEffect(() => {
    if (!seen || gone || kind !== "video") return;
    const closing = new AbortController();
    setHasAudio(null);
    const probe = async () => {
      for (;;) {
        const response = await fetch(
          `/api/cutroom/projects/${encodeURIComponent(projectId)}/media/probe?path=${encodeURIComponent(path)}&v=${encodeURIComponent(changed ?? "")}`,
          { signal: closing.signal },
        );
        if (response.status !== 202) {
          if (!response.ok)
            throw new Error(`Cannot probe ${path} (${response.status}).`);
          const info = z
            .object({ channels: z.number().positive().optional() })
            .parse(await response.json());
          if (!closing.signal.aborted) setHasAudio(info.channels !== undefined);
          return;
        }
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 200));
        closing.signal.throwIfAborted();
      }
    };
    void probe().catch((error: unknown) => {
      if (!closing.signal.aborted) console.warn("Media probe failed", error);
    });
    return () => closing.abort();
  }, [seen, gone, kind, projectId, path, changed]);
  const src = mediaUrl(projectId, path, changed);
  const measure = (element: HTMLMediaElement) => {
    if (Number.isFinite(element.duration)) setDuration(element.duration);
  };
  // A row goes onto the timeline once its length is known.
  const placeable =
    !gone &&
    (kind === "image" ||
      (duration !== null && (kind !== "video" || hasAudio !== null)));
  const dragged = (): MediaDrag => ({
    kind,
    path,
    seconds: duration ?? STILL_SECONDS,
    hasAudio: hasAudio ?? kind === "audio",
  });
  // The source viewer needs a timeline: its playhead counts the timeline's frames.
  const open = () => {
    if (!placeable || !useTimeline.getState().view) return;
    openSource(dragged());
    // The transport keys go to the source now, not to moving through the list.
    row.current?.blur();
  };
  return (
    <li
      className="media-row"
      aria-label={path}
      title={
        uses
          ? `${path} · Used by ${uses} ${uses === 1 ? "clip" : "clips"}`
          : path
      }
      data-used={uses || undefined}
      data-kind={kind}
      data-offline={offline || undefined}
      data-path={path}
      ref={row}
      tabIndex={tabbable ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocus();
      }}
      draggable={placeable && !renaming}
      onDragStart={(event) => {
        if (!placeable) return event.preventDefault();
        event.dataTransfer.setData(MEDIA_DRAG_TYPE, path);
        event.dataTransfer.effectAllowed = "copy";
        setMediaDrag(dragged());
      }}
      onDragEnd={() => setMediaDrag(null)}
      onDoubleClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget)
          open();
      }}
      onContextMenu={(event) => {
        if (gone)
          return openContextMenu(
            event,
            path,
            [
              {
                label: "Copy path",
                run: () =>
                  void navigator.clipboard.writeText(`${projectPath}/${path}`),
              },
            ],
            event.currentTarget,
          );
        // Needs the file's length and a timeline to put it on.
        const unplaceable = !placeable || !useTimeline.getState().view;
        const reveal = revealRows(`${projectPath}/${path}`);
        openContextMenu(
          event,
          path,
          [
            {
              label: "Open in source viewer",
              disabled: unplaceable,
              run: open,
            },
            "separator",
            {
              label: "Insert at playhead",
              disabled: unplaceable,
              run: () => void placeAtPlayhead(projectId, dragged(), "insert"),
            },
            {
              label: "Overwrite at playhead",
              disabled: unplaceable,
              run: () =>
                void placeAtPlayhead(projectId, dragged(), "overwrite"),
            },
            "separator",
            { label: "Rename", run: onRename },
            { label: "Remove", run: onRemove },
            ...(reveal.length ? ["separator" as const, ...reveal] : []),
          ],
          event.currentTarget,
        );
      }}
    >
      <span className="media-thumb" aria-hidden="true">
        {seen && !gone && kind === "video" && (
          <video
            src={`${src}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            onLoadedMetadata={(event) => measure(event.currentTarget)}
          />
        )}
        {!gone && kind === "audio" && (
          <>
            <Waveform size={14} />
            {seen && (
              <audio
                src={src}
                preload="metadata"
                onLoadedMetadata={(event) => measure(event.currentTarget)}
              />
            )}
          </>
        )}
        {kind === "image" && !gone && <img src={src} alt="" loading="lazy" />}
      </span>
      {renaming && !gone ? (
        <RenameField
          name={fileName(path)}
          onCommit={onRenameCommit}
          onCancel={() => {
            // Focus moves first: the row takes the keys back as the field closes.
            if (row.current?.contains(document.activeElement))
              focusByKeyboard(row.current);
            onRenameCancel();
          }}
        />
      ) : (
        <span className="media-name">{fileName(path)}</span>
      )}
      <span className="media-duration mono">
        {offline
          ? "Offline"
          : kind === "image"
            ? "Still"
            : duration !== null && (
                <TimecodeText timecode={frameTimecode(duration, fps)} />
              )}
      </span>
    </li>
  );
}

export function MediaPanel({
  projectId,
  projectPath,
  hidden,
}: {
  projectId: string;
  projectPath: string;
  hidden: boolean;
}) {
  // Read here rather than in the shell, so a burst of file events re-renders only this panel.
  const revision = useWorkspace((state) => state.mediaRevision);
  const [listedMedia, setListedMedia] = useState<
    { path: string; kind: (typeof mediaKinds)[number]["kind"] }[] | null
  >(null);
  const offline = useOfflineMedia(projectId);
  const media = useMemo(() => {
    if (!listedMedia || !offline.size) return listedMedia;
    const paths = new Map(listedMedia.map((item) => [item.path, item]));
    for (const path of offline.keys()) {
      const type = mediaKind(path);
      if (type) paths.set(path, { path, kind: type.kind });
    }
    return [...paths.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [listedMedia, offline]);
  const [query, setQuery] = useState("");
  const visibleMedia = useMemo(() => {
    if (!query.trim()) return media;
    const matches = mediaSearch(query);
    return media?.filter(({ path }) => matches(path));
  }, [media, query]);
  const [focused, setFocused] = useState<string>();
  const tabbable = visibleMedia?.some((item) => item.path === focused)
    ? focused
    : visibleMedia?.[0]?.path;
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const compositions = useCompositions(projectId);
  // The list appears once the project has a scene; the root alone needs no list.
  const [view, setView] = useState<"media" | "compositions">("media");
  const showing =
    compositions && compositions.length > 1 ? view : ("media" as const);
  const [message, setMessage] = useState("");
  const [renaming, setRenaming] = useState<string>();
  /** A file the timeline still uses, waiting for the owner's answer. */
  const [used, setUsed] = useState<{
    path: string;
    uses: number;
    keyboard: boolean;
  }>();
  const keepButton = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  /** The row that takes focus once the list shows it: a renamed file, or a removed one's neighbour. */
  const focusNext = useRef<string | null>(undefined);
  const busy = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  // Its panel key lands on the list's current file, or on Import while there is none.
  useKeymap({
    viewActiveWindowSelectionMediaPoolClips: () => {
      if (hidden) return;
      focusMediaRow(
        panel.current?.querySelector<HTMLElement>('.media-row[tabindex="0"]') ??
          search.current ??
          importButton.current,
      );
    },
  });
  const projectUrl = `/api/projects/${encodeURIComponent(projectId)}`;
  const composition = useTimeline((state) =>
    state.projectId === projectId ? state.composition : "index.html",
  );
  const cutroomUrl = `/projects/${encodeURIComponent(projectId)}`;

  const latestLoad = useRef(0);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const loaded = useRef(false);
  /** The files of the last listing, to tell which ones a new listing no longer has. */
  const listed = useRef({ projectUrl, files: [] as string[] });

  const load = useCallback(async () => {
    const id = ++latestLoad.current;
    const response = await fetch(
      `${projectUrl}?${new URLSearchParams({ mediaComposition: composition })}`,
    );
    if (id !== latestLoad.current) return;
    if (!response.ok)
      throw new Error(`The project media could not load (${response.status}).`);
    const { files, fileVersions } = projectFilesSchema.parse(
      await response.json(),
    );
    if (!active.current || id !== latestLoad.current) return;
    loaded.current = true;
    // A file that left the listing is gone, as the watcher will say. Saying so here keeps a
    // clip that still names it from asking the server for it before the timeline catches up.
    useWorkspace.setState(({ fileChanges }) => ({
      fileChanges: {
        ...Object.fromEntries(
          [
            ...(listed.current.projectUrl === projectUrl
              ? listed.current.files
              : []),
            ...Object.keys(fileChanges).filter(
              (path) => fileChanges[path] === null,
            ),
          ]
            .filter((path) => !(path in fileVersions))
            .map((path) => [path, null]),
        ),
        ...fileVersions,
      },
    }));
    listed.current = { projectUrl, files };
    const source = useSource.getState().file;
    if (source && !files.includes(source.path)) closeSource();
    setListedMedia(
      files
        .flatMap((path) => {
          const type = mediaKind(path);
          return type && typeof fileVersions[path] === "string"
            ? [{ path, kind: type.kind }]
            : [];
        })
        .sort((a, b) => a.path.localeCompare(b.path)),
    );
  }, [projectUrl, composition]);

  useEffect(() => {
    // A bulk copy reports each file; one trailing reload covers the burst.
    const timer = setTimeout(
      () =>
        void load().catch((error: unknown) =>
          setMessage(error instanceof Error ? error.message : String(error)),
        ),
      loaded.current ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [load, revision]);

  useEffect(() => {
    const path = focusNext.current;
    if (
      path === undefined ||
      (path !== null && !media?.some((item) => item.path === path))
    )
      return;
    focusNext.current = undefined;
    const row =
      path === null
        ? null
        : list.current?.querySelector<HTMLElement>(
            `[data-path="${CSS.escape(path)}"]`,
          );
    focusMediaRow(row ?? search.current ?? importButton.current);
  }, [media]);

  const failed = (error: unknown) =>
    setMessage(error instanceof Error ? error.message : String(error));

  /** One file action at a time, each ending with the list read again. */
  async function change(work: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setMessage("");
    try {
      await work();
      await load();
    } finally {
      busy.current = false;
    }
  }

  /** False when the name was refused after Enter, which leaves the field open to correct. */
  function rename(path: string, stem: string, by: "key" | "blur") {
    const current = fileName(path);
    const name = `${stem}${current.slice(current.lastIndexOf("."))}`;
    return change(async () => {
      const renamed = await api(
        `${cutroomUrl}/media/rename`,
        z.object({ path: z.string() }),
        json("POST", { path, name }),
      );
      useSource.setState(({ file }) => ({
        file: file?.path === path ? { ...file, path: renamed.path } : file,
      }));
      if (by === "key") focusNext.current = renamed.path;
      setRenaming(undefined);
    }).then(
      () => true,
      (error: unknown) => {
        failed(error);
        // A name left by clicking away is dropped with its refusal shown.
        if (by === "blur") setRenaming(undefined);
        return by === "blur";
      },
    );
  }

  /**
   * `keyboard` when the row was reached by keyboard: the next row then takes focus, so the keys
   * keep working down the list. After a click they stay the timeline's.
   */
  async function remove(
    path: string,
    keyboard = document.activeElement instanceof HTMLElement &&
      document.activeElement.dataset.path === path &&
      reachedByKeyboard(document.activeElement),
    confirmUsed = false,
  ) {
    const index = visibleMedia?.findIndex((item) => item.path === path) ?? -1;
    const neighbour =
      visibleMedia?.[index + 1]?.path ?? visibleMedia?.[index - 1]?.path;
    await change(async () => {
      if (!confirmUsed) {
        const { uses } = await api(
          `${cutroomUrl}/media/uses?path=${encodeURIComponent(path)}`,
          z.object({ uses: z.number() }),
        );
        if (uses) return setUsed({ path, uses, keyboard });
      }
      const response = await fetch(`/api/cutroom${cutroomUrl}/media/remove`, {
        ...json("POST", { path, confirmUsed }),
        headers: { "content-type": "application/json" },
      });
      const body: unknown = await response.json();
      const asked = z.object({ uses: z.number().positive() }).safeParse(body);
      if (response.status === 409 && asked.success && !confirmUsed) {
        setUsed({ path, uses: asked.data.uses, keyboard });
        return;
      }
      if (!response.ok)
        throw new Error(
          z.object({ error: z.string() }).safeParse(body).data?.error ??
            `The file could not be removed (${response.status}).`,
        );
      if (useSource.getState().file?.path === path) closeSource();
      if (keyboard) focusNext.current = neighbour ?? null;
      const { entries } = await api(
        `${cutroomUrl}/history`,
        z.object({
          entries: z.array(z.object({ id: z.string(), undone: z.boolean() })),
        }),
      );
      const removal = entries.findLast((entry) => !entry.undone)?.id;
      const dismiss = showToast(
        `Moved ${fileName(path)} to the project's ${MEDIA_TRASH} folder.`,
        {
          label: "Undo",
          run: () => {
            dismiss();
            void stepHistory(projectId, "undo", removal).catch(
              (error: unknown) =>
                showToast(
                  error instanceof Error ? error.message : String(error),
                ),
            );
          },
        },
        { tone: "info", transient: true },
      );
    }).catch(failed);
  }

  async function importFiles(list: FileList | null) {
    const files = [...(list ?? [])];
    const unsupported = files.filter((file) => !mediaKind(file.name));
    const media = files.filter((file) => mediaKind(file.name));
    if (!media.length) {
      if (unsupported.length)
        setMessage(
          `Not imported. ${unsupported.map((file) => file.name).join(", ")} is not a supported video, audio, or image format.`,
        );
      return;
    }
    if (importing) {
      setMessage(STILL_IMPORTING);
      return;
    }
    // Refuse before sending: a server rejecting a huge body can surface as a reset, not a 413.
    if (media.reduce((total, file) => total + file.size, 0) > UPLOAD_BYTES) {
      setMessage(UPLOAD_LIMIT);
      return;
    }
    const body = new FormData();
    for (const file of media) body.append("file", file);
    setImporting(true);
    setMessage("");
    try {
      const response = await fetch(`${projectUrl}/upload?dir=assets`, {
        method: "POST",
        body,
      });
      if (response.status === 413) throw new Error(UPLOAD_LIMIT);
      if (!response.ok)
        throw new Error(`The import failed (${response.status}).`);
      const result = uploadSchema.parse(await response.json());
      const refused = [
        ...unsupported.map((file) => `${file.name} is not a supported format`),
        ...result.skipped.map((name) => `${name} is too large`),
        ...result.invalid.map((item) => `${item.name}: ${item.reason}`),
      ];
      if (refused.length) setMessage(`Not imported. ${refused.join(". ")}.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
      setMessage((current) => (current === STILL_IMPORTING ? "" : current));
    }
  }

  const acceptsFiles = (event: DragEvent) =>
    event.dataTransfer.types.includes("Files");
  const updateSearch = (value: string) => {
    setQuery(value);
    if (!value && !media?.length) focusByKeyboard(importButton.current);
  };

  return (
    <section
      ref={panel}
      className="media-panel"
      aria-label="Media"
      hidden={hidden}
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        if (!acceptsFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next)))
          setDragging(false);
      }}
      onDrop={(event) => {
        if (!acceptsFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        void importFiles(event.dataTransfer.files);
      }}
    >
      <header className="panel-header">
        {compositions && compositions.length > 1 ? (
          <h2 className="panel-views">
            {(
              [
                ["media", "Media", media?.length ?? 0],
                ["compositions", "Compositions", compositions.length],
              ] as const
            ).map(([value, label, count]) => (
              <button
                key={value}
                className="panel-view"
                aria-pressed={showing === value}
                onClick={() => setView(value)}
              >
                {label}
                {count > 0 && <span className="panel-count">{count}</span>}
              </button>
            ))}
          </h2>
        ) : (
          <>
            <h2>Media</h2>
            {media && media.length > 0 && (
              <span className="panel-count">{media.length}</span>
            )}
          </>
        )}
        <button
          ref={importButton}
          className="icon-button"
          aria-label="Import media"
          title="Import media"
          disabled={importing}
          hidden={showing !== "media"}
          onClick={() => picker.current?.click()}
        >
          <Plus />
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept={acceptedFiles}
          onChange={(event) => {
            void importFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </header>
      {message && (
        <p className="media-message" role="alert">
          {message}
        </p>
      )}
      <div className="media-body">
        {showing === "media" && (!!media?.length || !!query) && (
          <div className="media-search">
            <MagnifyingGlass aria-hidden />
            <input
              ref={search}
              type="search"
              aria-label="Search media"
              placeholder="Search media"
              spellCheck={false}
              autoComplete="off"
              value={query}
              onChange={(event) => updateSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  event.stopPropagation();
                  updateSearch("");
                }
                if (event.key === "ArrowDown") {
                  const first =
                    list.current?.querySelector<HTMLElement>(".media-row");
                  if (!first) return;
                  event.preventDefault();
                  focusMediaRow(first);
                }
              }}
            />
          </div>
        )}
        {showing === "compositions" && compositions ? (
          <CompositionList projectId={projectId} paths={compositions} />
        ) : query.trim() && visibleMedia?.length === 0 ? (
          <div className="media-empty" role="status">
            No matching media
          </div>
        ) : media?.length === 0 ? (
          <div className="media-empty">
            <strong>{importing ? "Importing" : "No media yet"}</strong>
            <span>Drop files here or import from your computer.</span>
          </div>
        ) : (
          <ul
            className="media-list"
            ref={list}
            onKeyDown={(event) => {
              if (
                !(event.target instanceof HTMLElement) ||
                !event.target.matches(".media-row") ||
                !reachedByKeyboard(event.target)
              )
                return;
              const action = actionFor(event.nativeEvent);
              const path = event.target.dataset.path;
              if (
                (action === "editBackspace" || action === "editDelete") &&
                path !== undefined
              ) {
                event.preventDefault();
                if (!offline.has(path)) void remove(path, true);
                return;
              }
              if (
                event.key === "ArrowLeft" ||
                event.key === "ArrowRight" ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey
              )
                return;
              const rows = [
                ...event.currentTarget.querySelectorAll<HTMLElement>(
                  ".media-row",
                ),
              ];
              const next = gridStep(
                event.key,
                rows.indexOf(event.target),
                1,
                rows.length,
              );
              if (next === null) return;
              event.preventDefault();
              focusMediaRow(rows[next]);
            }}
          >
            {visibleMedia?.map(({ path, kind }) => (
              <MediaRow
                key={path}
                projectId={projectId}
                projectPath={projectPath}
                path={path}
                kind={kind}
                offline={offline.has(path)}
                tabbable={path === tabbable}
                onFocus={() => {
                  setFocused(path);
                }}
                renaming={path === renaming}
                onRename={() => setRenaming(path)}
                onRenameCommit={(stem, by) => rename(path, stem, by)}
                onRenameCancel={() => setRenaming(undefined)}
                onRemove={() => void remove(path)}
              />
            ))}
          </ul>
        )}
      </div>
      {used && (
        <Modal
          title={`Remove ${fileName(used.path)}?`}
          onClose={() => setUsed(undefined)}
          initialFocus={keepButton}
        >
          <p className="media-confirm">
            {`This file has ${used.uses} ${used.uses === 1 ? "use" : "uses"} in the project. Removing it leaves existing clips and references offline until you undo.`}
          </p>
          <footer className="modal-actions">
            <button
              ref={keepButton}
              className="secondary-button"
              onClick={() => setUsed(undefined)}
            >
              Keep file
            </button>
            <button
              className="secondary-button media-confirm-remove"
              onClick={() => {
                setUsed(undefined);
                void remove(used.path, used.keyboard, true);
              }}
            >
              Remove
            </button>
          </footer>
        </Modal>
      )}
    </section>
  );
}
