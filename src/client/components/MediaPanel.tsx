import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Plus, Waveform } from "@phosphor-icons/react";
import { z } from "zod";
import { frameTimecode } from "../api";
import {
  MEDIA_DRAG_TYPE,
  STILL_SECONDS,
  setMediaDrag,
} from "../timeline/mediaDrag";
import { useFps, useWorkspace } from "../workspace";

// Mirrors the formats the upload route validates. `.ts` transport streams are left out so
// TypeScript files in a project are never listed as video.
const mediaKinds = [
  {
    kind: "video",
    extensions: [
      "mp4",
      "webm",
      "mov",
      "mkv",
      "avi",
      "m4v",
      "mxf",
      "mts",
      "m2ts",
    ],
  },
  {
    kind: "audio",
    extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac"],
  },
  {
    kind: "image",
    extensions: ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"],
  },
] as const;
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

const mediaKind = (path: string) => {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return mediaKinds.find((item) =>
    item.extensions.some((candidate) => candidate === extension),
  );
};

/** One row: a thumbnail, the file name, and its length read from the file itself. */
function MediaRow({
  projectId,
  path,
  kind,
}: {
  projectId: string;
  path: string;
  kind: (typeof mediaKinds)[number]["kind"];
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
  const src = `/api/projects/${encodeURIComponent(projectId)}/preview/${path.split("/").map(encodeURIComponent).join("/")}${changed ? `?v=${encodeURIComponent(changed)}` : ""}`;
  const measure = (element: HTMLMediaElement) => {
    if (Number.isFinite(element.duration)) setDuration(element.duration);
  };
  return (
    <li
      className="media-row"
      title={path}
      data-kind={kind}
      ref={row}
      // A row drags onto a timeline track once its length is known.
      draggable={
        kind === "image" ||
        (duration !== null && (kind !== "video" || hasAudio !== null))
      }
      onDragStart={(event) => {
        event.dataTransfer.setData(MEDIA_DRAG_TYPE, path);
        event.dataTransfer.effectAllowed = "copy";
        setMediaDrag({
          kind,
          path,
          seconds: duration ?? STILL_SECONDS,
          hasAudio: hasAudio ?? kind === "audio",
        });
      }}
      onDragEnd={() => setMediaDrag(null)}
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
      <span className="media-name">{path.split("/").at(-1)}</span>
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
  hidden,
}: {
  projectId: string;
  hidden: boolean;
}) {
  // Read here rather than in the shell, so a burst of file events re-renders only this panel.
  const revision = useWorkspace((state) => state.mediaRevision);
  const [media, setMedia] = useState<
    { path: string; kind: (typeof mediaKinds)[number]["kind"] }[] | null
  >(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const projectUrl = `/api/projects/${encodeURIComponent(projectId)}`;

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
          <ul className="media-list">
            {media?.map(({ path, kind }) => (
              <MediaRow
                key={path}
                projectId={projectId}
                path={path}
                kind={kind}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
