import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Plus, Waveform } from "@phosphor-icons/react";
import { z } from "zod";
import { MEDIA_TRASH, mediaKind, mediaKinds } from "../../shared/media";
import { api, frameTimecode, json, mediaUrl } from "../api";
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
import { openContextMenu, revealRows } from "./ContextMenu";
import { Modal } from "./Modal";

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

/** One row: a thumbnail, the file name, and its length read from the file itself. */
function MediaRow({
  projectId,
  projectPath,
  path,
  kind,
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
  useEffect(() => setDuration(null), [changed]);
  useEffect(() => {
    if (!seen || kind !== "video") return;
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
  }, [seen, kind, projectId, path, changed]);
  const src = mediaUrl(projectId, path, changed);
  const measure = (element: HTMLMediaElement) => {
    if (Number.isFinite(element.duration)) setDuration(element.duration);
  };
  // A row goes onto the timeline once its length is known.
  const placeable =
    kind === "image" ||
    (duration !== null && (kind !== "video" || hasAudio !== null));
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
      title={path}
      data-kind={kind}
      data-path={path}
      ref={row}
      tabIndex={tabbable ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocus();
      }}
      draggable={placeable && !renaming}
      onDragStart={(event) => {
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
        {seen && kind === "video" && (
          <video
            src={`${src}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            onLoadedMetadata={(event) => measure(event.currentTarget)}
          />
        )}
        {kind === "audio" && (
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
        {kind === "image" && <img src={src} alt="" loading="lazy" />}
      </span>
      {renaming ? (
        <RenameField
          name={fileName(path)}
          onCommit={onRenameCommit}
          onCancel={() => {
            // Focus moves first: the row takes the keys back as the field closes.
            if (row.current?.contains(document.activeElement))
              row.current.focus({ preventScroll: true });
            onRenameCancel();
          }}
        />
      ) : (
        <span className="media-name">{fileName(path)}</span>
      )}
      <span className="media-duration mono">
        {kind === "image"
          ? "Still"
          : duration !== null && frameTimecode(duration, fps)}
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
  const [media, setMedia] = useState<
    { path: string; kind: (typeof mediaKinds)[number]["kind"] }[] | null
  >(null);
  const [focused, setFocused] = useState<string>();
  const tabbable = media?.some((item) => item.path === focused)
    ? focused
    : media?.[0]?.path;
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const [renaming, setRenaming] = useState<string>();
  /** A file the timeline still uses, waiting for the owner's answer. */
  const [used, setUsed] = useState<{
    path: string;
    uses: number;
    keyboard: boolean;
  }>();
  const keepButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  /** The row that takes focus once the list shows it: a renamed file, or a removed one's neighbour. */
  const focusNext = useRef<string>(undefined);
  const busy = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  // Its panel key lands on the list's current file, or on Import while there is none.
  useKeymap({
    viewActiveWindowSelectionMediaPoolClips: () => {
      if (hidden) return;
      focusByKeyboard(
        panel.current?.querySelector<HTMLElement>('.media-row[tabindex="0"]') ??
          panel.current?.querySelector<HTMLElement>("button"),
      );
    },
  });
  const projectUrl = `/api/projects/${encodeURIComponent(projectId)}`;
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

  const load = useCallback(async () => {
    const id = ++latestLoad.current;
    const response = await fetch(projectUrl);
    if (id !== latestLoad.current) return;
    if (!response.ok)
      throw new Error(`The project media could not load (${response.status}).`);
    const { files, fileVersions } = projectFilesSchema.parse(
      await response.json(),
    );
    if (!active.current || id !== latestLoad.current) return;
    loaded.current = true;
    useWorkspace.setState({ fileChanges: fileVersions });
    setMedia(
      files
        .flatMap((path) => {
          const type = mediaKind(path);
          return type ? [{ path, kind: type.kind }] : [];
        })
        .sort((a, b) => a.path.localeCompare(b.path)),
    );
  }, [projectUrl]);

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
    if (path === undefined || !media?.some((item) => item.path === path))
      return;
    focusNext.current = undefined;
    focusByKeyboard(
      list.current?.querySelector<HTMLElement>(
        `[data-path="${CSS.escape(path)}"]`,
      ),
    );
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
    const index = media?.findIndex((item) => item.path === path) ?? -1;
    const neighbour = media?.[index + 1]?.path ?? media?.[index - 1]?.path;
    await change(async () => {
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
      if (keyboard) focusNext.current = neighbour;
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
        <h2>Media</h2>
        {media && media.length > 0 && (
          <span className="panel-count">{media.length}</span>
        )}
        <button
          className="icon-button"
          aria-label="Import media"
          title="Import media"
          disabled={importing}
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
        {media?.length === 0 ? (
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
                void remove(path, true);
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
              focusByKeyboard(rows[next]);
            }}
          >
            {media?.map(({ path, kind }) => (
              <MediaRow
                key={path}
                projectId={projectId}
                projectPath={projectPath}
                path={path}
                kind={kind}
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
            {used.uses === 1
              ? "1 clip on the timeline uses this file. It stays in place and plays nothing until you undo."
              : `${used.uses} clips on the timeline use this file. They stay in place and play nothing until you undo.`}
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
