import { mediaKind } from "../media";
import type { Clip } from "./schema";

/** A scene version is an HTML composition file; the query or hash does not count. */
export const isCompositionFile = (src: string) =>
  /\.html?$/i.test(src.split(/[?#]/, 1)[0]!);

/** Whether `src` can be a version of a clip of this kind. */
export const fitsVersion = (kind: Clip["kind"], src: string) =>
  kind === "composition"
    ? isCompositionFile(src)
    : kind === "image" && mediaKind(src.split(/[?#]/, 1)[0]!)?.kind === "image";

/** The place of the version a clip shows in its list, or -1 when it has none. */
export const activeVersion = (clip: Pick<Clip, "src" | "versions">) =>
  clip.versions?.findIndex(({ src }) => src === clip.src) ?? -1;
