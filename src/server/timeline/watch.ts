import { statSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { fileContentVersion } from "@hyperframes/studio-server";

const recentWrites = new Map<
  string,
  { origin: string; identity: string; version: string }
>();

const identity = ({ dev, ino, ctimeNs, size }: BigIntStats) =>
  `${dev}:${ino}:${ctimeNs}:${size}`;

function fileIdentity(path: string) {
  try {
    const info = statSync(path, { bigint: true, throwIfNoEntry: false });
    return info?.isFile() ? identity(info) : null;
  } catch {
    // When the watcher cannot prove the identity, the tab reads the timeline normally.
    return null;
  }
}

/** A save's watcher echo must match its exact bytes and the same file on disk. A restore or an
 * outside rewrite can have the same bytes with a different identity. */
export function rememberTimelineWrite(
  path: string,
  version: () => string,
  origin?: string,
) {
  if (!origin) return;
  const fresh = fileIdentity(path);
  if (!fresh) return;
  recentWrites.delete(path);
  recentWrites.set(path, { origin, version: version(), identity: fresh });
  if (recentWrites.size > 256)
    recentWrites.delete(recentWrites.keys().next().value!);
}

export async function isTimelineWriteEcho(path: string, origin: string) {
  const written = recentWrites.get(path);
  if (written?.origin !== origin || fileIdentity(path) !== written.identity)
    return false;
  const file = await Bun.file(path)
    .bytes()
    .catch(() => null);
  return (
    file !== null &&
    fileIdentity(path) === written.identity &&
    fileContentVersion(file) === written.version
  );
}
