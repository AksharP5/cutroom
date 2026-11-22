import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { HttpError } from "../../shared/errors";
import { sourceUrl } from "../../shared/media";
import { isTimelinePath } from "../../shared/sourcePaths";
import {
  PROJECT_DOCUMENT_PATH,
  ProjectDocumentSchema,
  TIMELINE_NAME_BYTES,
} from "../../shared/project";
import type { DuplicateTimelineSchema, Project } from "../../shared/project";
import type { HistoryFileChange, HistoryWho } from "../history/historyLog";
import type { ProjectHistory } from "../history/projectHistory";
import { copyCaptions } from "../captions/captions";
import { createCaptionsFile, placedCaptions } from "../captions/project";
import { rewriteElements } from "../timeline/composition";
import type { AttributeChange } from "../timeline/composition";
import { canonicalProjectPath } from "./path";
import { readSource } from "./store";
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
      const path = await store.createFile(
        project,
        Array.from(
          { length: 999 },
          (_, copy) => `${copy ? `${name} ${copy + 1}` : name}.html`,
        ),
        () => html,
      );
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
  );
  await projectViews.copyTimeline(project, source, composition);
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
