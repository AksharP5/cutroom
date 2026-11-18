import type { Project } from "../../shared/project";
import { localMediaPath } from "../../shared/media";
import { TimelineError } from "../../shared/timeline/errors";
import { VersionsSchema } from "../../shared/timeline/schema";
import type {
  Clip,
  ClipKind,
  Command,
  Timeline,
  Version,
} from "../../shared/timeline/schema";
import { activeVersion } from "../../shared/timeline/versions";
import { projectPath } from "../projects/path";
import type { AttributeChange, HostedComposition } from "./composition";

/** The clip's versions as JSON: the list a scene or image clip can switch between. */
export const VERSIONS_ATTRIBUTE = "data-cutroom-versions";

/**
 * A clip's versions, when its attribute holds a valid list that includes the file it shows.
 * Anything else, such as a hand-edited `src` outside the list, reads as no versions.
 */
export function readVersions(
  kind: ClipKind,
  src: string | null,
  attribute: string | undefined,
): Version[] | undefined {
  if (attribute === undefined || src === null) return undefined;
  if (kind !== "composition" && kind !== "image") return undefined;
  let json: unknown;
  try {
    json = JSON.parse(attribute);
  } catch {
    return undefined;
  }
  const parsed = VersionsSchema.safeParse(json);
  if (!parsed.success) return undefined;
  // Names are written canonical; a list that parses differently was not written by Cutroom.
  if (JSON.stringify(parsed.data) !== JSON.stringify(json)) return undefined;
  return parsed.data.some((version) => version.src === src)
    ? parsed.data
    : undefined;
}

/** A new clip's versions attribute, when it holds versions. */
export const versionAttributes = (clip: Clip): AttributeChange[] =>
  clip.versions ? [[VERSIONS_ATTRIBUTE, JSON.stringify(clip.versions)]] : [];

/** Attribute changes that show `after`'s active version and keep its list. */
export function versionChanges(
  before: Clip,
  after: Clip,
  attrs: Readonly<Record<string, string>>,
  hosted: (src: string) => HostedComposition,
): AttributeChange[] {
  const list = (clip: Clip) =>
    clip.versions ? JSON.stringify(clip.versions) : null;
  const changes: AttributeChange[] = [];
  if (list(before) !== list(after))
    changes.push([VERSIONS_ATTRIBUTE, list(after)]);
  if (before.src === after.src || after.src === null) return changes;
  if (after.kind === "image") return [...changes, ["src", after.src]];
  const scene = hosted(after.src);
  changes.push(["data-composition-src", after.src]);
  // The bundler finds the scene's root by this id, so a stale one would mount nothing.
  if (attrs["data-composition-id"] !== undefined)
    changes.push(["data-composition-id", scene.id]);
  for (const [name, value] of [
    ["data-width", scene.width],
    ["data-height", scene.height],
  ] as const)
    if ((attrs[name] ?? null) !== value) changes.push([name, value]);
  return changes;
}

/** A versions list with each file rewritten, as a paste into another folder rewrites `src`. */
export function rebaseVersions(
  attribute: string,
  rewrite: (src: string) => string,
): string {
  try {
    const versions = VersionsSchema.parse(JSON.parse(attribute));
    return JSON.stringify(
      versions.map((version) => ({ ...version, src: rewrite(version.src) })),
    );
  } catch {
    return attribute;
  }
}

/**
 * The files a batch's version commands can show, each checked to be a visible file of this
 * project: agents name them, so a path cannot leave the project or reach a hidden folder.
 */
export async function versionFiles(
  project: Pick<Project, "path">,
  composition: string,
  timeline: Timeline,
  commands: readonly Command[],
): Promise<string[]> {
  const sources = commands.flatMap((command) => {
    if (command.type === "setVersions")
      return command.versions.map(({ src }) => src);
    if (command.type !== "setVersion" && command.type !== "keepVersion")
      return [];
    const clip = timeline.clips.find(({ id }) => id === command.clipId);
    // A piece the same batch cuts or pastes is a copy of a clip here, so it holds their files.
    if (!clip)
      return timeline.clips.flatMap(
        ({ versions }) => versions?.map(({ src }) => src) ?? [],
      );
    const src = clip.versions?.[command.version ?? activeVersion(clip)]?.src;
    return src === undefined ? [] : [src];
  });
  for (const src of new Set(sources)) {
    const path = localMediaPath(composition, src);
    if (
      path === null ||
      path === "." ||
      path.startsWith("../") ||
      path.split("/").some((part) => part.startsWith("."))
    )
      throw new TimelineError(
        "unsupported",
        `Version "${src}" must be a file in this project, outside hidden folders.`,
      );
    const found = await projectPath(project, path).then(
      () => true,
      () => false,
    );
    if (!found)
      throw new TimelineError(
        "not_found",
        `Version "${src}" is not a file in this project.`,
      );
  }
  return [...new Set(sources)];
}
