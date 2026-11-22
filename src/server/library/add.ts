import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import { COMPONENT_SECONDS, libraryTitle } from "../../shared/library";
import type { LibraryAdd, LibraryAdded } from "../../shared/library";
import { fileFingerprint, sourceUrl } from "../../shared/media";
import type { Project } from "../../shared/project";
import { applyAll, toFrames } from "../../shared/timeline/apply";
import { TimelineError } from "../../shared/timeline/errors";
import { CommandSchema } from "../../shared/timeline/schema";
import type { Timeline, TimelineView } from "../../shared/timeline/schema";
import { checkVariableValues } from "../../shared/variables";
import type { HistoryWho } from "../history/historyLog";
import { projectWritePath } from "../projects/path";
import type { ReviewService } from "../projects/review";
import { readSource } from "../projects/store";
import type { ProjectStore } from "../projects/store";
import type { createTimelineRoutes } from "../timeline/routes";
import { setElementAttributes } from "../timeline/composition";
import { REGISTRY_LICENSE } from "./registry";
import type { Library, RegistryItem } from "./registry";
import { PROJECT_VENDOR, gsapDist, withProjectScripts } from "./scripts";

type TimelineRoutes = Pick<
  ReturnType<typeof createTimelineRoutes>,
  "editInWindow" | "timelineSnapshot"
>;

const PROJECT_GSAP = `${PROJECT_VENDOR}/gsap.min.js`;

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("'", "&#39;");

/** The `tl.` lines of a fragment's "Timeline integration" note, which animate it. */
export function integrationRecipe(snippet: string) {
  const note = /Timeline integration:([\s\S]*?)-->/.exec(snippet)?.[1] ?? "";
  return note
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("tl."))
    .join("\n");
}

/** Whether a component's snippet is a whole composition, or a fragment to paste into one. */
export const isComposition = (snippet: string) =>
  /\bdata-composition-id\s*=/.test(snippet);

/**
 * A composition at the timeline's size around a fragment component: its markup, styles and
 * script as written, its variables declared on the root, and its own timeline built from the
 * recipe its author wrote for hosts. Like the rest of the item, the recipe runs only in the
 * preview's sandbox and the renderer.
 */
export function componentHost(
  item: Pick<RegistryItem, "name" | "variables">,
  snippet: string,
  size: { width: number; height: number },
  path: string,
) {
  const recipe = integrationRecipe(snippet).replaceAll("</", "<\\/");
  const declarations = item.variables.length
    ? ` data-composition-variables='${attribute(JSON.stringify(item.variables))}'`
    : "";
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <script src="${sourceUrl(path, PROJECT_GSAP)}"></script>
  </head>
  <body>
    <div data-composition-id="${item.name}" data-width="${size.width}" data-height="${size.height}" data-duration="${COMPONENT_SECONDS}"${declarations}>
      <style>
        [data-composition-id="${item.name}"] {
          position: relative;
          width: ${size.width}px;
          height: ${size.height}px;
          overflow: hidden;
          display: grid;
          place-items: center;
        }
      </style>
${snippet}
      <script>
        (function () {
          var tl = gsap.timeline({ paused: true });
          var startTime = 0;
${recipe}
          window.__timelines = window.__timelines || {};
          window.__timelines["${item.name}"] = tl;
        })();
      </script>
    </div>
  </body>
</html>
`;
}

/** `compositions/name.html`, then `compositions/name-2.html` and on. */
const numbered = (path: string, copy: number) =>
  copy === 1 ? path : path.replace(/(\.[^./]+)?$/, `-${copy}$1`);

/**
 * An item's files as they land in a project, its scene first: GSAP and its plugins pointed at the
 * project's own copies (which join the list), and a fragment component replaced by its host.
 * `size` is the timeline's, which a host is drawn at.
 */
export async function itemProjectFiles(
  library: Library,
  item: RegistryItem,
  size: { width: number; height: number },
) {
  const cached = await library.files(item);
  const bytesOf = (target: string) =>
    readFile(join(library.itemDir(item.name), target));
  const scene =
    item.files.find((file) => file.type === "hyperframes:composition") ??
    item.files.find((file) => file.type === "hyperframes:snippet");
  if (!scene || !cached.some(({ target }) => target === scene.target))
    throw new HttpError(422, `${item.title} has no composition to place.`);
  const text = new TextDecoder();
  const snippet = text.decode(await bytesOf(scene.target));
  const fragment =
    item.type === "hyperframes:component" && !isComposition(snippet);
  const files: { path: string; bytes: Uint8Array | string }[] = [];
  const vendored = new Set<string>();
  const local = (html: string, path: string) => {
    const result = withProjectScripts(html, path);
    for (const file of result.vendored) vendored.add(file);
    return result.html;
  };
  for (const { target } of cached) {
    // A fragment plays from its host, which holds it; on its own it is no composition.
    if (fragment && target === scene.target) continue;
    const bytes = await bytesOf(target);
    files.push({
      path: target,
      bytes: /\.html?$/i.test(target)
        ? local(text.decode(bytes), target)
        : bytes,
    });
  }
  const host = posix.join("compositions", `${item.name}.html`);
  if (fragment) {
    vendored.add("gsap.min.js");
    files.push({
      path: host,
      bytes: componentHost(item, local(snippet, host), size, host),
    });
  }
  for (const file of vendored)
    files.push({
      path: `${PROJECT_VENDOR}/${file}`,
      bytes: await readFile(join(gsapDist, file)),
    });
  const scenePath = fragment ? host : scene.target;
  files.sort(
    (a, b) => Number(b.path === scenePath) - Number(a.path === scenePath),
  );
  return { scene: scenePath, files };
}

/** The commands that place the item: its track made first when it is new, then the clip. */
function placement(
  timeline: Timeline,
  input: {
    track: number;
    at: number;
    mode: "insert" | "overwrite";
    duration?: number;
  },
  item: RegistryItem,
  src: string,
  label: string,
) {
  return z.array(CommandSchema).parse([
    ...(timeline.tracks.some(({ index }) => index === input.track)
      ? []
      : [{ type: "setTrack", index: input.track, kind: "video" }]),
    {
      type: "insert",
      mode: input.mode,
      track: input.track,
      at: input.at,
      clip: {
        kind: "composition",
        src,
        duration:
          input.duration ??
          toFrames(item.duration ?? COMPONENT_SECONDS, timeline.fps),
        label,
      },
    },
  ]);
}

/**
 * Copies a library item into the project and places it as a scene clip, in one history entry.
 * Files the project already has unchanged are reused. An edited copy of the item's scene keeps
 * its edits and the new one goes in beside it as `name-2.html`; an edited asset is kept as it is.
 * The item's license, author and source are recorded in cutroom.json beside the files it added;
 * an item without a license of its own carries the registry's, marked as inherited.
 */
export async function addLibraryItem({
  store,
  reviews,
  library,
  timeline,
  project,
  input,
  token,
  who,
}: {
  store: ProjectStore;
  reviews: ReviewService;
  library: Library;
  timeline: TimelineRoutes;
  project: Project;
  input: Required<Pick<LibraryAdd, "composition" | "mode">> &
    Omit<LibraryAdd, "composition" | "mode">;
  token: string | undefined;
  who: HistoryWho | undefined;
}): Promise<LibraryAdded> {
  const item = await library.item(input.name);
  const { disabled } = library.describe(item, false);
  if (disabled) throw new HttpError(422, `${item.title}: ${disabled}`);
  const variables = checkVariableValues(input.variables ?? {}, item.variables);
  const title = libraryTitle(item.title);
  const label = `Added ${title} from the HyperFrames library`;
  // A placement the engine refuses, such as onto an audio or locked track, is refused before
  // anything is downloaded or written.
  const current: TimelineView | { error: string } =
    await timeline.timelineSnapshot(project, input.composition);
  if ("error" in current) throw new HttpError(422, current.error);
  const refusal = (error: unknown) =>
    error instanceof TimelineError ? new HttpError(422, error.message) : error;
  try {
    applyAll(
      current.timeline,
      placement(
        current.timeline,
        input,
        item,
        "compositions/placed.html",
        title,
      ),
      { composition: input.composition },
    );
  } catch (error) {
    throw refusal(error);
  }
  // Downloads happen before the edit starts, so a slow network never holds the project.
  // The preview and export draw a composition without a size at 1920 x 1080.
  const { scene, files } = await itemProjectFiles(
    library,
    item,
    current.size ?? { width: 1920, height: 1080 },
  );

  return reviews.editComposition(
    project,
    input.composition,
    token,
    async () => {
      const { value, entry } = await store.mutateWithEntry(
        project,
        label,
        async () => {
          const added: string[] = [];
          const kept: string[] = [];
          const placedFiles = new Set<string>();
          /**
           * Puts `bytes` at `path` unless the project has them there already. A different file
           * at `path` is the project's own edit: kept, or, with `rename`, left beside a new copy.
           */
          const place = async (
            path: string,
            bytes: Uint8Array | string,
            rename: boolean,
          ): Promise<string> => {
            const hash = sha256(bytes);
            for (let copy = 1; copy < 100; copy++) {
              const target = numbered(path, copy);
              placedFiles.add(target);
              const absolute = await projectWritePath(project, target, {
                allowMissing: true,
                sourceOnly: false,
              });
              const existing = await readFile(absolute).catch(
                (error: unknown) => {
                  if (
                    error instanceof Error &&
                    "code" in error &&
                    error.code === "ENOENT"
                  )
                    return null;
                  throw error;
                },
              );
              if (existing && sha256(existing) === hash) return target;
              if (existing && !rename) {
                kept.push(target);
                return target;
              }
              if (existing) {
                placedFiles.delete(target);
                continue;
              }
              await mkdir(dirname(absolute), { recursive: true });
              await writeFile(absolute, bytes, { flag: "wx" });
              store.captureHistoryCreation(absolute, bytes);
              added.push(target);
              return target;
            }
            throw new HttpError(
              409,
              `The project has too many edited copies of ${path}.`,
            );
          };

          let scenePath = scene;
          for (const file of files) {
            // An edited scene stays beside the new copy; an edited asset or GSAP is the owner's.
            const placed = await place(
              file.path,
              file.bytes,
              file.path === scene,
            );
            if (file.path === scene) scenePath = placed;
          }

          let before = new Set<string>();
          const src = sourceUrl(input.composition, scenePath);
          const view = await timeline
            .editInWindow(
              project,
              input.composition,
              (latest: Timeline) => {
                before = new Set(latest.clips.map((clip) => clip.id));
                return placement(latest, input, item, src, title);
              },
              token !== undefined,
            )
            .catch((error: unknown) => {
              throw refusal(error);
            });
          const clip = view.timeline.clips.find(
            (candidate) =>
              !before.has(candidate.id) &&
              candidate.kind === "composition" &&
              candidate.src === src,
          );
          if (!clip)
            throw new HttpError(
              500,
              `${title} was not placed on the timeline.`,
            );

          if (Object.keys(variables).length) {
            const source = await readSource(project, input.composition);
            const after = setElementAttributes(source.content, clip.id, [
              ["data-variable-values", JSON.stringify(variables)],
            ]);
            if (!after)
              throw new HttpError(500, `${title}'s values were not saved.`);
            store.writeFiles(project, [
              {
                sourceFile: input.composition,
                absPath: await projectWritePath(project, input.composition),
                before: source.content,
                after,
                expectedVersion: source.version,
              },
            ]);
          }

          const document = await store.document(project);
          const record = {
            name: item.name,
            ref: library.ref,
            source: `registry/${item.type === "hyperframes:block" ? "blocks" : "components"}/${item.name}`,
            license: item.license ?? REGISTRY_LICENSE,
            ...(item.license ? {} : { licenseInherited: true as const }),
            ...(item.author && { author: item.author }),
            files: files
              .map(({ path }) => (path === scene ? scenePath : path))
              .filter((path) => !path.startsWith(`${PROJECT_VENDOR}/`)),
          };
          const others = (document.library ?? []).filter(
            (entry) => entry.name !== item.name,
          );
          const previous = document.library?.find(
            (entry) => entry.name === item.name,
          );
          // The store matches a write to the read it changes, so the record goes on that object.
          document.library = [
            ...others,
            previous
              ? {
                  ...record,
                  files: [...new Set([...previous.files, ...record.files])],
                }
              : record,
          ];
          await store.writeDocument(project, document);
          const versions = Object.fromEntries(
            await Promise.all(
              [...placedFiles].map(async (path) => [
                path,
                fileFingerprint(
                  path,
                  await stat(
                    await projectWritePath(project, path, {
                      sourceOnly: false,
                    }),
                  ),
                ),
              ]),
            ),
          );
          return {
            clipId: clip.id,
            composition: scenePath,
            added,
            kept,
            versions,
          };
        },
        who,
        { category: "library" },
      );
      return { entry, value: { ...value, historyId: entry?.id } };
    },
    undefined,
    { label },
  );
}
