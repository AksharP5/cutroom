import { stat } from "node:fs/promises";
import type { Project } from "../../shared/project";
import { localMediaPath } from "../../shared/media";
import { TimelineError } from "../../shared/timeline/errors";
import {
  MAX_VERSIONS,
  StoredVersionSchema,
} from "../../shared/timeline/schema";
import type {
  Clip,
  ClipKind,
  Command,
  Timeline,
  Version,
} from "../../shared/timeline/schema";
import {
  activeVersion,
  fitsVersion,
  mediaVersions,
} from "../../shared/timeline/versions";
import { resolveProjectPath } from "../projects/path";
import type { AttributeChange, HostedComposition } from "./composition";

/** The clip's versions as JSON: the list a scene or image clip can switch between. */
export const VERSIONS_ATTRIBUTE = "data-cutroom-versions";

export const VERSION_INDEX_ATTRIBUTE = "data-cutroom-version-index";
export const VERSION_SILENT_ATTRIBUTE = "data-cutroom-version-silent";

function storedList(attribute: string | undefined) {
  if (attribute === undefined) return undefined;
  try {
    const raw: unknown = JSON.parse(attribute);
    const parsed = StoredVersionSchema.array()
      .min(2)
      .max(MAX_VERSIONS)
      .safeParse(raw);
    if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(raw))
      return undefined;
    const versions = parsed.data;
    return new Set(versions.map(({ name }) => name)).size === versions.length
      ? versions
      : undefined;
  } catch {
    return undefined;
  }
}

/** The authored list, provided it matches the mounted source. */
export function readVersions(
  kind: ClipKind,
  src: string | null,
  attribute: string | undefined,
  indexAttribute?: string,
): { versions?: Version[]; versionIndex?: number } {
  const versions = storedList(attribute);
  if (
    !versions ||
    !src ||
    versions.some((version) => !fitsVersion(kind, version.src))
  )
    return {};
  if (mediaVersions(kind)) {
    const versionIndex =
      indexAttribute === undefined ? -1 : Number(indexAttribute);
    return versions[versionIndex]?.src === src &&
      versions.every((version) => version.sourceIn !== undefined)
      ? { versions, versionIndex }
      : {};
  }
  return versions.some((version) => version.src === src) ? { versions } : {};
}

const stored = (clip: Clip) =>
  clip.versions
    ? JSON.stringify(
        clip.versions.map(({ name, src, sourceIn, sourceFps }) => ({
          name,
          src,
          sourceIn,
          sourceFps,
        })),
      )
    : null;

/** A new clip's version attributes. */
export const versionAttributes = (clip: Clip): AttributeChange[] => [
  ...(clip.versions ? [[VERSIONS_ATTRIBUTE, stored(clip)] as const] : []),
  ...(clip.versionIndex === undefined
    ? []
    : [[VERSION_INDEX_ATTRIBUTE, String(clip.versionIndex)] as const]),
  ...(clip.versionSilent
    ? ([
        [VERSION_SILENT_ATTRIBUTE, ""],
        ["muted", ""],
      ] as const)
    : []),
];

/** Attribute changes that show `after`'s active version and keep its list. */
export function versionChanges(
  before: Clip,
  after: Clip,
  attrs: Readonly<Record<string, string>>,
  hosted: (src: string) => HostedComposition,
): AttributeChange[] {
  const changes: AttributeChange[] = [];
  const list = stored(after);
  if (stored(before) !== list) changes.push([VERSIONS_ATTRIBUTE, list]);
  if (before.versionIndex !== after.versionIndex)
    changes.push([
      VERSION_INDEX_ATTRIBUTE,
      after.versionIndex === undefined ? null : String(after.versionIndex),
    ]);
  if (before.versionSilent !== after.versionSilent)
    changes.push(
      [
        VERSION_SILENT_ATTRIBUTE,
        after.versionSilent ? (attrs.muted === undefined ? "" : "muted") : null,
      ],
      ...(attrs[VERSION_SILENT_ATTRIBUTE] === "muted" ||
      (attrs.muted !== undefined && after.versionSilent)
        ? []
        : [["muted", after.versionSilent ? "" : null] as const]),
    );
  if (before.src === after.src || after.src === null) return changes;
  if (after.kind !== "composition") return [...changes, ["src", after.src]];
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
    const versions = storedList(attribute);
    if (!versions) return attribute;
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
    if (command.type === "addVersion")
      return command.version ? [command.version.src] : [];
    if (command.type !== "setVersion" && command.type !== "keepVersion")
      return [];
    const clip = timeline.clips.find(({ id }) => id === command.clipId);
    // A piece the same batch cuts or pastes is a copy of a clip here, so it holds their files.
    if (!clip)
      return timeline.clips.flatMap(({ kind, versions }) =>
        mediaVersions(kind) ? [] : (versions?.map(({ src }) => src) ?? []),
      );
    if (mediaVersions(clip.kind)) return [];
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
    const found = await resolveProjectPath(project, path).catch(() => null);
    if (found?.path.split("/").some((part) => part.startsWith(".")))
      throw new TimelineError(
        "unsupported",
        `Version "${src}" must be a file in this project, outside hidden folders.`,
      );
    if (!found || !(await stat(found.absolute).catch(() => null))?.isFile())
      throw new TimelineError(
        "not_found",
        `Version "${src}" is not a file in this project.`,
      );
  }
  return [...new Set(sources)];
}
