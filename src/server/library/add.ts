import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { HttpError } from "../../shared/errors";
import { COMPONENT_SECONDS, libraryTitle } from "../../shared/library";
import type { LibraryAdd, LibraryAdded } from "../../shared/library";
import { sourceUrl } from "../../shared/media";
import type { Project } from "../../shared/project";
import { toFrames } from "../../shared/timeline/apply";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import type { Timeline } from "../../shared/timeline/schema";
import { checkVariableValues } from "../../shared/variables";
import type { HistoryWho } from "../history/historyLog";
import { projectWritePath } from "../projects/path";
import type { ReviewService } from "../projects/review";
import { readSource } from "../projects/store";
import type { ProjectStore } from "../projects/store";
import type { createTimelineRoutes } from "../timeline/routes";
import {
  compositionScope,
  compositionSize,
  parseComposition,
  setElementAttributes,
} from "../timeline/composition";
import type { Library, RegistryItem } from "./registry";

type EditInWindow = ReturnType<typeof createTimelineRoutes>["editInWindow"];

/** Where Cutroom projects keep the pinned GSAP build, which preview and export load offline. */
const PROJECT_GSAP = "assets/vendor/gsap.min.js";
/** Registry items load GSAP's core from this CDN, which the sandboxed preview cannot reach. */
const CDN_GSAP =
  /(["'])https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@[\d.]+\/dist\/gsap\.min\.js\1/g;

/** An item's HTML with its GSAP script pointed at the project's own copy. */
export const withProjectGsap = (html: string, path: string) =>
  html.replace(
    CDN_GSAP,
    (_, quote: string) => `${quote}${sourceUrl(path, PROJECT_GSAP)}${quote}`,
  );

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
 * Copies a library item into the project and places it as a scene clip, in one history entry.
 * Files the project already has unchanged are reused. An edited copy of the item's scene keeps
 * its edits and the new one goes in beside it as `name-2.html`; an edited asset is kept as it is.
 * The item's license, author and source are recorded in cutroom.json beside the files it added.
 */
export async function addLibraryItem({
  store,
  reviews,
  library,
  editInWindow,
  project,
  input,
  token,
  who,
}: {
  store: ProjectStore;
  reviews: ReviewService;
  library: Library;
  editInWindow: EditInWindow;
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
  // Downloads happen before the edit starts, so a slow network never holds the project.
  const cached = await library.files(item);
  const bytesOf = (target: string) =>
    readFile(join(library.itemDir(item.name), target));
  const scene =
    item.files.find((file) => file.type === "hyperframes:composition") ??
    item.files.find((file) => file.type === "hyperframes:snippet");
  if (!scene || !cached.some(({ target }) => target === scene.target))
    throw new HttpError(422, `${item.title} has no composition to place.`);
  const fragment =
    item.type === "hyperframes:component" &&
    !isComposition(new TextDecoder().decode(await bytesOf(scene.target)));
  const title = libraryTitle(item.title);
  const label = `Added ${title} from the HyperFrames library`;

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
              if (existing) continue;
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

          const text = new TextDecoder();
          let scenePath = scene.target;
          let gsap = false;
          for (const { target } of cached) {
            // A fragment plays from the host below, which holds it; on its own it is no composition.
            if (fragment && target === scene.target) continue;
            let bytes: Uint8Array | string = await bytesOf(target);
            if (/\.html?$/i.test(target)) {
              const html = text.decode(bytes);
              bytes = withProjectGsap(html, target);
              gsap ||= bytes !== html;
            }
            const placed = await place(target, bytes, target === scene.target);
            if (target === scene.target) scenePath = placed;
          }

          if (fragment) {
            const { content } = await readSource(project, input.composition);
            const size = compositionSize(
              parseComposition(content, emptyTimelineSettings(), {
                scope: compositionScope(input.composition),
              }).root,
            );
            const host = posix.join("compositions", `${item.name}.html`);
            scenePath = await place(
              host,
              componentHost(
                item,
                text.decode(await bytesOf(scene.target)),
                size,
                host,
              ),
              true,
            );
            gsap = true;
          }
          // An imported project may not have the copy yet; an edited one is the owner's to keep.
          if (gsap)
            await place(
              PROJECT_GSAP,
              await readFile(
                Bun.resolveSync("gsap/dist/gsap.min.js", import.meta.dir),
              ),
              false,
            );

          let before = new Set<string>();
          const src = sourceUrl(input.composition, scenePath);
          const view = await editInWindow(
            project,
            input.composition,
            (current: Timeline) => {
              before = new Set(current.clips.map((clip) => clip.id));
              const duration =
                input.duration ??
                toFrames(item.duration ?? COMPONENT_SECONDS, current.fps);
              return [
                ...(current.tracks.some(({ index }) => index === input.track)
                  ? []
                  : [
                      {
                        type: "setTrack" as const,
                        index: input.track,
                        kind: "video" as const,
                      },
                    ]),
                {
                  type: "insert",
                  mode: input.mode,
                  track: input.track,
                  at: input.at,
                  clip: { kind: "composition", src, duration, label: title },
                },
              ];
            },
            token !== undefined,
          );
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
            ...(item.license && { license: item.license }),
            ...(item.author && { author: item.author }),
            files: [
              ...new Set([...cached.map(({ target }) => target), scenePath]),
            ],
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
          return { clipId: clip.id, composition: scenePath, added, kept };
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
