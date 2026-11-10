import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { FilmStrip, Image, Plus, Waveform } from "@phosphor-icons/react";
import { z } from "zod";
import { useWorkspace } from "../workspace";

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
    icon: FilmStrip,
  },
  {
    kind: "audio",
    extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac"],
    icon: Waveform,
  },
  {
    kind: "image",
    extensions: ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"],
    icon: Image,
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

const projectFilesSchema = z.object({ files: z.array(z.string()) });
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
    { path: string; type: (typeof mediaKinds)[number] }[] | null
  >(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const projectUrl = `/api/projects/${encodeURIComponent(projectId)}`;

  const latestLoad = useRef(0);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    const id = ++latestLoad.current;
    const response = await fetch(projectUrl);
    if (id !== latestLoad.current) return;
    if (!response.ok)
      throw new Error(`The project media could not load (${response.status}).`);
    const { files } = projectFilesSchema.parse(await response.json());
    if (id !== latestLoad.current) return;
    loaded.current = true;
    setMedia(
      files
        .flatMap((path) => {
          const type = mediaKind(path);
          return type ? [{ path, type }] : [];
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
          <Plus size={14} />
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
      {media?.length === 0 ? (
        <div className="media-empty">
          <strong>{importing ? "Importing" : "No media yet"}</strong>
          <span>Drop files here or import from your computer.</span>
        </div>
      ) : (
        <ul className="media-list">
          {media?.map(({ path, type }) => {
            const Icon = type.icon;
            const name = path.split("/").at(-1) ?? path;
            const extension = name.split(".").at(-1);
            return (
              <li key={path} title={path} data-kind={type.kind}>
                <Icon size={14} aria-label={type.kind} />
                <span>{name.slice(0, -(extension?.length ?? 0) - 1)}</span>
                <small>{extension}</small>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
