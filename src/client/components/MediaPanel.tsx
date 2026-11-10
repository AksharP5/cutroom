import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { FilmStrip, Image, Plus, Waveform } from "@phosphor-icons/react";
import { z } from "zod";

const mediaKinds = [
  { kind: "video", pattern: /\.(mp4|webm|mov|m4v)$/i, icon: FilmStrip },
  { kind: "audio", pattern: /\.(mp3|wav|ogg|m4a|aac|flac)$/i, icon: Waveform },
  { kind: "image", pattern: /\.(jpe?g|png|gif|webp|avif|svg)$/i, icon: Image },
] as const;

const projectFilesSchema = z.object({ files: z.array(z.string()) });
const uploadSchema = z.object({
  files: z.array(z.string()),
  skipped: z.array(z.string()).default([]),
  invalid: z
    .array(z.object({ name: z.string(), reason: z.string() }))
    .default([]),
});
const fileChangeSchema = z.object({ projectId: z.string(), path: z.string() });

const mediaKind = (path: string) =>
  mediaKinds.find((item) => item.pattern.test(path));

async function request<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
) {
  const response = await fetch(url, init);
  if (!response.ok)
    throw new Error(`The project media could not load (${response.status}).`);
  return schema.parse(await response.json());
}

export function MediaPanel({
  projectId,
  hidden,
}: {
  projectId: string;
  hidden: boolean;
}) {
  const [media, setMedia] = useState<
    { path: string; type: (typeof mediaKinds)[number] }[] | null
  >(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const projectUrl = `/api/projects/${encodeURIComponent(projectId)}`;

  const load = useCallback(async () => {
    const { files } = await request(projectUrl, projectFilesSchema);
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
    const report = (error: unknown) =>
      setMessage(error instanceof Error ? error.message : String(error));
    void load().catch(report);
    const events = new EventSource("/api/events");
    events.addEventListener("file-change", (event) => {
      if (!(event instanceof MessageEvent)) return;
      const change = fileChangeSchema.safeParse(JSON.parse(String(event.data)));
      if (
        change.success &&
        change.data.projectId === projectId &&
        mediaKind(change.data.path)
      )
        void load().catch(report);
    });
    return () => events.close();
  }, [load, projectId]);

  async function importFiles(files: FileList | null) {
    if (!files?.length || importing) return;
    const body = new FormData();
    for (const file of files) body.append("file", file);
    setImporting(true);
    setMessage("");
    try {
      const result = await request(
        `${projectUrl}/upload?dir=assets`,
        uploadSchema,
        { method: "POST", body },
      );
      const refused = [
        ...result.skipped.map((name) => `${name} is too large`),
        ...result.invalid.map((item) => `${item.name}: ${item.reason}`),
      ];
      if (refused.length) setMessage(`Not imported. ${refused.join(". ")}.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
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
          accept="video/*,audio/*,image/*"
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
