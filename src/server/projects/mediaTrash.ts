import { posix } from "node:path";
import type { HistoryEntry } from "../history/historyLog";
import {
  FREEZE_EXPORT_DIR,
  MEDIA_TRASH,
  freezeExportPath,
  isFreezeExport,
} from "../../shared/media";

const exportTrash = `${MEDIA_TRASH}/${FREEZE_EXPORT_DIR}`;

/** The label already stored for Media Remove entries. */
export const mediaRemoveLabel = (path: string) =>
  `Remove ${posix.basename(path)}`;

export function mediaTrashPath(source: string, copy: number) {
  const name = posix.basename(source);
  const extension = posix.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const directory = isFreezeExport(source) ? exportTrash : MEDIA_TRASH;
  return `${directory}/${stem}${copy === 1 ? "" : ` ${copy}`}${extension}`;
}

/** Only a recorded Media Remove can match its own source to a trash path. */
export function removedFreezeSource(
  entry: HistoryEntry,
  trash: string,
  hash: string,
) {
  const directory = posix.dirname(trash);
  if (directory !== MEDIA_TRASH && directory !== exportTrash) return;
  if (entry.who.kind === "outside") return;
  const preview = entry.files.find(
    ({ path, before, after }) =>
      before !== null &&
      after === null &&
      freezeExportPath(path) &&
      entry.label === mediaRemoveLabel(path),
  );
  if (!preview) return;
  const source =
    directory === MEDIA_TRASH ? preview.path : freezeExportPath(preview.path);
  if (
    !entry.files.some(
      ({ path, before, after }) =>
        path === source && before === hash && after === null,
    )
  )
    return;
  const additions = entry.files.filter(
    ({ path, before, after }) =>
      before === null && after === hash && posix.dirname(path) === directory,
  );
  if (additions.length === 1 && additions[0]?.path === trash) return source;
}
