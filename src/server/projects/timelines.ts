import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { z } from "zod";
import { HttpError } from "../../shared/errors";
import { sourceUrl } from "../../shared/media";
import { isTimelinePath } from "../../shared/sourcePaths";
import type { DuplicateTimelineSchema, Project } from "../../shared/project";
import type { HistoryWho } from "../history/historyLog";
import { copyCaptions } from "../captions/captions";
import { createCaptionsFile, placedCaptions } from "../captions/project";
import { rewriteElements } from "../timeline/composition";
import type { AttributeChange } from "../timeline/composition";
import { canonicalProjectPath, projectWritePath } from "./path";
import { readSource } from "./store";
import type { ProjectStore } from "./store";
import { projectViews } from "./view";

const TRANSCRIPT_ATTRIBUTES = [
  "data-cutroom-transcript",
  "data-cutroom-anchor",
] as const;

/** A file name any desktop file system accepts, without its extension. */
const fileName = (name: string) =>
  name
    .replace(/\.html?$/i, "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "") || "Timeline";

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
      let path: string | undefined;
      for (let copy = 1; !path && copy < 1000; copy++) {
        const candidate = `${copy === 1 ? name : `${name} ${copy}`}.html`;
        const absolute = await projectWritePath(project, candidate, {
          allowMissing: true,
        });
        const created = await writeFile(absolute, html, { flag: "wx" }).then(
          () => true,
          (error: unknown) => {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "EEXIST"
            )
              return false;
            throw error;
          },
        );
        if (!created) continue;
        store.captureHistoryCreation(absolute, html);
        path = candidate;
      }
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
