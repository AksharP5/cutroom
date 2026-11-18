import { memo, useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { ProjectSchema } from "../../../shared/project";
import { mediaKind } from "../../../shared/media";
import { api, mediaUrl } from "../../api";

const projectPath = ProjectSchema.pick({ path: true });

function Attachment({
  path,
  src,
  onRemove,
}: {
  path: string;
  src?: string;
  onRemove: (path: string) => void;
}) {
  const [failed, setFailed] = useState<string>();
  const name = path.split("/").at(-1) ?? path;
  const thumbnail = src && src !== failed;
  return (
    <span
      className="chat-attachment"
      data-thumbnail={thumbnail || undefined}
      title={name}
    >
      {thumbnail ? (
        <img src={src} alt={name} onError={() => setFailed(src)} />
      ) : (
        <span>{name}</span>
      )}
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={() => onRemove(path)}
      >
        <X />
      </button>
    </span>
  );
}

export const Attachments = memo(function Attachments({
  projectId,
  paths,
  onRemove,
}: {
  projectId: string;
  paths: readonly string[];
  onRemove: (path: string) => void;
}) {
  const [root, setRoot] = useState("");
  const hasImages = paths.some((path) => mediaKind(path)?.kind === "image");

  useEffect(() => {
    if (!hasImages || root) return;
    const request = new AbortController();
    void api(`/projects/${encodeURIComponent(projectId)}`, projectPath, {
      signal: request.signal,
    })
      .then(({ path }) => {
        if (!request.signal.aborted) setRoot(path.replace(/\/$/, "") + "/");
      })
      .catch((error: unknown) => {
        if (!request.signal.aborted)
          console.warn("Could not load attachment previews", error);
      });
    return () => request.abort();
  }, [hasImages, projectId, root]);

  return (
    <div className="attachment-list">
      {paths.map((path) => {
        const relative =
          root && path.startsWith(root) ? path.slice(root.length) : "";
        const file =
          mediaKind(relative)?.kind === "image" &&
          relative
            .split("/")
            .every((part) => part && part !== "." && part !== "..");
        const src = file ? mediaUrl(projectId, relative) : undefined;
        return (
          <Attachment key={path} path={path} src={src} onRemove={onRemove} />
        );
      })}
    </div>
  );
});
