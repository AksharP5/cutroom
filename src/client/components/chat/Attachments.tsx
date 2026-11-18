import { memo, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { AgentAttachment } from "../../../shared/agent";
import { mediaKind } from "../../../shared/media";
import type { Project } from "../../../shared/project";
import { mediaUrl } from "../../api";
import { Modal } from "../Modal";

type Preview = { name: string; src: string };

function Attachment({
  path,
  src,
  onRemove,
  onOpen,
}: {
  path: string;
  src?: string;
  onRemove?: (path: string) => void;
  onOpen: (preview: Preview) => void;
}) {
  const [failed, setFailed] = useState<string>();
  const name = path.split("/").at(-1) ?? path;
  const thumbnail = src && src !== failed;
  const image = thumbnail && (
    <img
      src={src}
      alt={name}
      onError={() => setFailed(src)}
      {...(!onRemove && {
        loading: "lazy",
        decoding: "async",
        width: 64,
        height: 36,
      })}
    />
  );
  return (
    <span
      className="chat-attachment"
      data-thumbnail={(onRemove ? thumbnail : Boolean(src)) || undefined}
      title={name}
    >
      {image ? (
        onRemove ? (
          image
        ) : (
          <button
            type="button"
            className="chat-attachment-open"
            onClick={() => onOpen({ name, src })}
          >
            {image}
          </button>
        )
      ) : (
        <span>{name}</span>
      )}
      {onRemove && (
        <button
          type="button"
          className="chat-attachment-remove"
          aria-label={`Remove ${name}`}
          onClick={() => onRemove(path)}
        >
          <X />
        </button>
      )}
    </span>
  );
}

export const Attachments = memo(function Attachments({
  project,
  files,
  onRemove,
}: {
  project: Pick<Project, "id" | "path">;
  files: readonly AgentAttachment[];
  onRemove?: (path: string) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const root = project.path.replace(/\/$/, "") + "/";

  return (
    <>
      <div
        className={
          onRemove ? "attachment-list" : "attachment-list sent-attachments"
        }
      >
        {files.map(({ path, mimeType }) => {
          const relative = path.startsWith(root) ? path.slice(root.length) : "";
          const image =
            mimeType?.startsWith("image/") ||
            mediaKind(relative)?.kind === "image";
          const src =
            image &&
            relative
              .split("/")
              .every((part) => part && part !== "." && part !== "..")
              ? mediaUrl(project.id, relative)
              : undefined;
          return (
            <Attachment
              key={path}
              path={path}
              src={src}
              onRemove={onRemove}
              onOpen={setPreview}
            />
          );
        })}
      </div>
      {preview && (
        <Modal title={preview.name} onClose={() => setPreview(null)}>
          <img
            className="chat-attachment-full"
            src={preview.src}
            alt={preview.name}
          />
        </Modal>
      )}
    </>
  );
});
