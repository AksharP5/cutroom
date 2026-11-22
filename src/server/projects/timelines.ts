import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { extname } from "node:path";
import type { z } from "zod";
import { HttpError } from "../../shared/errors";
import { sourceUrl } from "../../shared/media";
import { isTimelinePath } from "../../shared/sourcePaths";
import {
  NEW_PROJECT_SECONDS,
  PROJECT_DOCUMENT_PATH,
  ProjectDocumentSchema,
  TIMELINE_NAME_BYTES,
} from "../../shared/project";
import type {
  DuplicateTimelineSchema,
  NewTimelineSchema,
  Project,
  ProjectDocument,
  RenameTimelineSchema,
} from "../../shared/project";
import type { HistoryFileChange, HistoryWho } from "../history/historyLog";
import type { ProjectHistory } from "../history/projectHistory";
import { copyCaptions } from "../captions/captions";
import {
  compositionFrame,
  createCaptionsFile,
  placedCaptions,
} from "../captions/project";
import { rewriteElements } from "../timeline/composition";
import type { AttributeChange } from "../timeline/composition";
import { moveFiles, referenceEdits } from "./mediaFiles";
import {
  canonicalProjectPath,
  isMissing,
  projectWritePath,
  rootHtmlFiles,
} from "./path";
import { readSource, timelinePage } from "./store";
import type { ProjectStore } from "./store";
import { projectViews } from "./view";

const TRANSCRIPT_ATTRIBUTES = [
  "data-cutroom-transcript",
  "data-cutroom-anchor",
] as const;

/**
 * A file name any desktop file system accepts, without its extension, short enough in bytes that
 * a copy number and `.html` still fit in 255.
 */
const fileName = (name: string) => {
  const safe =
    name
      .replace(/\.html?$/i, "")
      .replace(/[<>:"/\\|?*]/g, "-")
      .replace(/^[.\s]+|[.\s]+$/g, "") || "Timeline";
  let fitted = "";
  for (const character of safe) {
    if (Buffer.byteLength(fitted + character) > TIMELINE_NAME_BYTES) break;
    fitted += character;
  }
  return fitted.trimEnd();
};

/** `name.html`, then `name 2.html` and on, for a new file that never takes an existing one's place. */
const numbered = (name: string, first = 1) =>
  Array.from(
    { length: 999 },
    (_, index) =>
      `${index + first > 1 ? `${name} ${index + first}` : name}.html`,
  );

export const timelineName = (project: Project, path: string) =>
  path === "index.html" ? project.name : path.replace(/\.html?$/i, "");

/**
 * Copies a timeline beside it in one history step: the file, its tracks, markers and range in
 * cutroom.json, and its transcripts and their captions under new ids, so Script and captions edit
 * the copy alone. Clip ids stay as they are: every per-clip record is keyed by composition too.
 * Track heights and destinations follow outside history, like any view preference.
 */
export async function duplicateTimeline(
  store: ProjectStore,
  project: Project,
  input: z.output<typeof DuplicateTimelineSchema>,
  who?: HistoryWho,
) {
  const source = canonicalProjectPath(input.composition);
  if (!isTimelinePath(source))
    throw new HttpError(
      400,
      "Choose a timeline: an .html file at the project root.",
    );
  const name = fileName(input.name ?? `${timelineName(project, source)} copy`);
  const { value: composition, entry } = await store.mutateWithEntry(
    project,
    `Duplicate ${timelineName(project, source)}`,
    async () => {
      const { content } = await readSource(project, source);
      const document = await store.document(project);
      const transcripts = new Map(
        document.transcripts
          .filter((transcript) => transcript.sourceFile === source)
          .map((transcript) => [transcript.id, randomUUID()]),
      );
      // Captions follow one transcript, so the copy's transcripts get their own captions files.
      const hosts = new Map<string, string>();
      for (const placed of transcripts.size
        ? await placedCaptions(project, source, content)
        : []) {
        const transcriptId = transcripts.get(placed.captions.transcriptId);
        if (!transcriptId) continue;
        const { content: captions } = await readSource(project, placed.file);
        const { file } = await createCaptionsFile(
          store,
          project,
          source,
          (id) => copyCaptions(captions, id, transcriptId)!,
        );
        hosts.set(placed.clipId, sourceUrl(source, file));
      }
      const rewrite = (html: string) =>
        transcripts.size
          ? rewriteElements(html, (attrs) => {
              const changes: AttributeChange[] = [];
              for (const attribute of TRANSCRIPT_ATTRIBUTES) {
                const id = transcripts.get(attrs[attribute] ?? "");
                if (id) changes.push([attribute, id]);
              }
              const captions = attrs.id && hosts.get(attrs.id);
              if (captions && attrs["data-composition-src"] !== undefined)
                changes.push(["data-composition-src", captions]);
              return changes;
            })
          : html;
      const html = rewrite(content);
      const path = await store.createFile(project, numbered(name), () => html);
      if (!path)
        throw new HttpError(409, `Too many timelines are named ${name}.`);
      const settings = document.timelines[source];
      if (settings || transcripts.size) {
        if (settings) document.timelines[path] = structuredClone(settings);
        for (const transcript of document.transcripts.filter(({ id }) =>
          transcripts.has(id),
        ))
          document.transcripts.push({
            ...structuredClone(transcript),
            id: transcripts.get(transcript.id)!,
            sourceFile: path,
            original: {
              ...transcript.original,
              html: rewrite(transcript.original.html),
            },
          });
        await store.writeDocument(project, document);
      }
      return path;
    },
    who,
    { category: "timeline" },
  );
  await projectViews.copyTimeline(project, source, composition);
  return { composition, ...(entry && { historyId: entry.id }) };
}

/**
 * Renames a timeline's file in one history step, carrying everything keyed by its path along:
 * its tracks, markers and range, its transcripts and its review notes in cutroom.json, and any
 * other timeline that plays it as a scene. Review state and view settings outside history move in
 * the review service, after this and whenever undo or redo moves the file.
 */
export async function renameTimeline(
  store: ProjectStore,
  project: Project,
  input: z.output<typeof RenameTimelineSchema>,
  who?: HistoryWho,
) {
  const source = canonicalProjectPath(input.composition);
  if (source === "index.html")
    throw new HttpError(
      400,
      "index.html is the main timeline and is named after the project. Rename the project instead.",
    );
  if (!isTimelinePath(source))
    throw new HttpError(
      400,
      "Choose a timeline: an .html file at the project root.",
    );
  const absolute = await projectWritePath(project, source);
  const name = fileName(input.name);
  const path = `${name}${extname(source)}`;
  if (path === source) return { composition: source };
  const destination = await projectWritePath(project, path, {
    allowMissing: true,
  });
  const { entry } = await store.mutateWithEntry(
    project,
    `Rename ${timelineName(project, source)} to ${name}`,
    async () => {
      // Checked inside the mutation, since a rename replaces whatever file has the name. The
      // same file under another case, on a disk that ignores case, is the timeline itself.
      const [taken, current] = await Promise.all([
        lstat(destination).catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        }),
        lstat(absolute),
      ]);
      if (taken && (taken.ino !== current.ino || taken.dev !== current.dev))
        throw new HttpError(
          409,
          `A timeline or file named ${path} already exists. Choose another name.`,
        );
      const document = await store.document(project);
      // cutroom.json is rekeyed by its fields below, not by every string that names the file.
      const edits = (
        await referenceEdits(project, new Map([[source, path]]), false)
      ).filter(({ sourceFile }) => sourceFile !== PROJECT_DOCUMENT_PATH);
      moveFiles([{ absolute, destination }], () =>
        store.writeFiles(project, edits),
      );
      if (moveDocument(document, source, path))
        await store.writeDocument(project, document);
    },
    who,
    { moves: new Set([source, path]), category: "timeline" },
  );
  return { composition: path, ...(entry && { historyId: entry.id }) };
}

/** Rekeys a timeline's records in cutroom.json from one path to another; false when it has none. */
function moveDocument(document: ProjectDocument, from: string, to: string) {
  let moved = false;
  const settings = document.timelines[from];
  if (settings) {
    delete document.timelines[from];
    document.timelines[to] = settings;
    moved = true;
  }
  for (const transcript of document.transcripts)
    if (transcript.sourceFile === from) {
      transcript.sourceFile = to;
      moved = true;
    }
  for (const annotation of document.annotations)
    if (annotation.compositionPath === from) {
      annotation.compositionPath = to;
      moved = true;
    }
  return moved;
}

/**
 * Adds an empty timeline beside the others in one history step, at the main timeline's picture
 * size and frame rate and a new project's length, named "Timeline 2", "Timeline 3" and on unless
 * `input` names it.
 */
export async function createTimeline(
  store: ProjectStore,
  project: Project,
  input: z.output<typeof NewTimelineSchema>,
  who?: HistoryWho,
) {
  // index.html is the first timeline, so the first new one is Timeline 2.
  const candidates =
    input.name === undefined
      ? numbered("Timeline", 2)
      : numbered(fileName(input.name));
  const taken = new Set(
    (await rootHtmlFiles(project)).map((file) => file.toLowerCase()),
  );
  // Named up front for its undo step; a timeline made meanwhile moves it on by a number.
  const first = candidates.findIndex((file) => !taken.has(file.toLowerCase()));
  if (first < 0) throw new HttpError(409, "Too many timelines have that name.");
  const { value: composition, entry } = await store.mutateWithEntry(
    project,
    `Create ${candidates[first]!.replace(/\.html$/, "")}`,
    async () => {
      const { fps, width, height } = compositionFrame(
        (await readSource(project, "index.html")).content,
      );
      const path = await store.createFile(
        project,
        candidates.slice(first),
        (file) =>
          timelinePage({
            name: file.replace(/\.html$/, ""),
            width,
            height,
            fps,
            duration: NEW_PROJECT_SECONDS,
          }),
      );
      if (!path) throw new HttpError(409, "Too many timelines have that name.");
      return path;
    },
    who,
    { category: "timeline" },
  );
  return { composition, ...(entry && { historyId: entry.id }) };
}

/**
 * The timelines a history step changed, through their file or their settings in cutroom.json.
 * A timeline the step creates or removes is left out: it is that step's subject, not where it lands.
 */
export async function changedTimelines(
  history: Pick<ProjectHistory, "readBlob">,
  files: readonly HistoryFileChange[],
) {
  const appeared = new Set(
    files
      .filter(
        ({ path, before, after }) => isTimelinePath(path) && !(before && after),
      )
      .map(({ path }) => path),
  );
  const changed = new Set(
    files
      .filter(
        ({ path, before, after }) => isTimelinePath(path) && before && after,
      )
      .map(({ path }) => path),
  );
  const settings = async (hash: string | null) =>
    hash === null
      ? {}
      : (ProjectDocumentSchema.safeParse(
          await history
            .readBlob(hash)
            .then((blob) => JSON.parse(blob.toString("utf8")) as unknown)
            .catch(() => null),
        ).data?.timelines ?? {});
  for (const { path, before, after } of files) {
    if (path !== PROJECT_DOCUMENT_PATH) continue;
    const [was, now] = await Promise.all([settings(before), settings(after)]);
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)]))
      if (!appeared.has(key) && !Bun.deepEquals(was[key], now[key]))
        changed.add(key);
  }
  return [...changed];
}
