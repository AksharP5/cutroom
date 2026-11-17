import { posix } from "node:path";
import { HttpError } from "../../shared/errors";
import { localMediaPath } from "../../shared/media";
import type { Project } from "../../shared/project";
import { projectPath } from "../projects/path";
import { readSource } from "../projects/store";
import { audioGroupReferences, compositionScope } from "./composition";
import type { ParsedComposition } from "./composition";

/** A group without a local declaration can resolve to the first matching bus in the bundle. */
export async function scopedAudioGroups(
  project: Project,
  composition: string,
  parsed: ParsedComposition,
) {
  const timeline = parsed.timeline;
  const groups = timeline.authoredAudioGroups;
  if (
    !groups?.some(
      ({ id, sourceRestriction }) =>
        parsed.routedAudioGroupIds.has(id) && !sourceRestriction,
    )
  )
    return timeline;

  const current = audioGroupReferences(parsed.scope, parsed);
  if (composition === "index.html" && !current.scenes.length) return timeline;
  const activePath = await projectPath(project, composition);
  const reads = new Map<
    string,
    Promise<ReturnType<typeof audioGroupReferences> | null>
  >([[composition, Promise.resolve(current)]]);
  const references = (path: string) => {
    let read = reads.get(path);
    if (!read) {
      read = projectPath(project, path)
        .then(async (absolute) => {
          if (absolute === activePath) return current;
          const { content } = await readSource(project, path);
          return audioGroupReferences(compositionScope(path), content);
        })
        .catch((error: unknown) => {
          if (error instanceof HttpError && error.status < 500) return null;
          throw error;
        });
      reads.set(path, read);
    }
    return read;
  };
  const visits = new Map<string, number>();
  const elsewhere = new Set<string>();
  let mounts = 0;
  let unavailable = false;
  const visit = async (path: string, source: typeof current) => {
    const count = (visits.get(path) ?? 0) + 1;
    // A second occurrence is enough to identify a reused scene and its descendants.
    if (count > 2) return;
    visits.set(path, count);
    if (source === current) mounts++;
    else for (const group of source.groups) elsewhere.add(group);
    for (const src of source.scenes) {
      const projectRelative = localMediaPath("index.html", src);
      if (projectRelative === null) {
        unavailable = true;
        continue;
      }
      // Timeline references are relative to their owning file. The bundled renderer can
      // also resolve a nested host relative to the entry document and use its raw URL path.
      const candidates = new Set([
        localMediaPath(path, src),
        projectRelative,
        posix.join(posix.dirname(path), src),
        posix.normalize(src).replace(/^\/+/, ""),
      ]);
      let found = false;
      for (const candidate of candidates) {
        if (!candidate || candidate === ".." || candidate.startsWith("../"))
          continue;
        const nested = await references(candidate);
        if (!nested) continue;
        found = true;
        await visit(candidate, nested);
      }
      if (!found) unavailable = true;
    }
  };
  const entry = await references("index.html");
  if (entry) await visit("index.html", entry);
  if (!mounts) {
    // An unmounted composition previews and exports as its own entry document.
    visits.clear();
    elsewhere.clear();
    unavailable = false;
    await visit(composition, current);
  }

  return {
    ...timeline,
    authoredAudioGroups: groups.map((group) => {
      const { id, sourceRestriction } = group;
      if (sourceRestriction || !parsed.routedAudioGroupIds.has(id))
        return group;
      const reason = elsewhere.has(id)
        ? `Audio group ${id} is also used in another composition.`
        : mounts > 1
          ? `This composition is mounted more than once.`
          : unavailable
            ? `Cutroom could not check every external scene for audio group ${id}.`
            : undefined;
      return reason
        ? {
            ...group,
            sourceRestriction: `${reason} Edit the group in the source.`,
          }
        : group;
    }),
  };
}
