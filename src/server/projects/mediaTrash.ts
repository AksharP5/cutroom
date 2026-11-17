import { posix } from "node:path";
import {
  FREEZE_DIR,
  FREEZE_EXPORT_DIR,
  MEDIA_TRASH,
  isFreezeExport,
} from "../../shared/media";

const exportTrash = `${MEDIA_TRASH}/${FREEZE_EXPORT_DIR}`;

export function mediaTrashPath(source: string, copy: number) {
  const name = posix.basename(source);
  const extension = posix.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const directory = isFreezeExport(source) ? exportTrash : MEDIA_TRASH;
  return `${directory}/${stem}${copy === 1 ? "" : ` ${copy}`}${extension}`;
}

/** A trash name may be the original filename or a numbered copy of a shorter name. */
export function freezeTrashSources(trash: string) {
  const directory = posix.dirname(trash);
  const sourceDir =
    directory === MEDIA_TRASH
      ? FREEZE_DIR
      : directory === exportTrash
        ? FREEZE_EXPORT_DIR
        : null;
  if (!sourceDir) return [];
  const name = posix.basename(trash);
  const extension = posix.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const sources = [`${sourceDir}/${name}`];
  const numbered = /^(.+) ([1-9]\d*)$/.exec(stem);
  if (numbered) {
    const source = `${sourceDir}/${numbered[1]}${extension}`;
    const copy = Number(numbered[2]);
    if (copy > 1 && mediaTrashPath(source, copy) === trash)
      sources.push(source);
  }
  return sources;
}
