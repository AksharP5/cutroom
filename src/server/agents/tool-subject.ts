import { z } from "zod";
import type { Project } from "../../shared/project";
import {
  CommandBatchSchema,
  emptyTimelineSettings,
} from "../../shared/timeline/schema";
import type { Clip, Command } from "../../shared/timeline/schema";
import { CUTROOM_SERVER, parseTool } from "../../shared/toolRow";
import type { ReviewService } from "../projects/review";
import { readSource } from "../projects/store";
import type { ProjectStore } from "../projects/store";
import { compositionScope, parseComposition } from "../timeline/composition";

/** What the editor calls the things a tool call names by id. */
export interface ToolNames {
  /** A review note, as its first words in quotes. */
  note(id: string): Promise<string | undefined>;
  /** A composition's clips by id, named as the timeline shows them. */
  clips(
    composition: string,
  ): Promise<ReadonlyMap<string, Pick<Clip, "label" | "src" | "kind">>>;
  /** The media file a transcript was made from. */
  transcript(id: string): Promise<string | undefined>;
}

const fileName = (path: string) => path.split("/").at(-1) ?? path;

/** The opening of a note, cut at a word, in the quotes the owner wrote it in. */
export function quoteNote(body: string, limit = 48) {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  if (flat.length <= limit) return `“${flat}”`;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `“${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?]+$/, "")}…”`;
}

/**
 * Names read from the project as it is now. A name is presentation only: when its source
 * cannot be read, the call keeps its generic wording ("a note", "the timeline") and still runs.
 */
export function projectNames(
  store: ProjectStore,
  review: ReviewService,
  project: Project,
): ToolNames {
  return {
    note: (id) =>
      review.list(project).then(
        (items) => {
          const item = items.find((candidate) => candidate.id === id);
          if (!item) return undefined;
          return (
            quoteNote(item.body) ??
            (item.kind === "drawing" ? "a drawing" : undefined)
          );
        },
        () => undefined,
      ),
    clips: (composition) =>
      readSource(project, composition).then(
        (source) =>
          new Map(
            parseComposition(source.content, emptyTimelineSettings(), {
              scope: compositionScope(composition),
            }).timeline.clips.map((clip) => [clip.id, clip]),
          ),
        () => new Map(),
      ),
    transcript: (id) =>
      store.document(project).then(
        (document) => {
          const transcript = document.transcripts.find(
            (candidate) => candidate.id === id,
          );
          return transcript && fileName(transcript.mediaPath);
        },
        () => undefined,
      ),
  };
}

const clipsOf = (command: Command) => {
  switch (command.type) {
    case "move":
    case "remove":
      return command.clipIds;
    case "split":
      return command.clipIds ?? [];
    case "trim":
    case "setClip":
    case "setTiming":
      return [command.clipId];
    default:
      return [];
  }
};

/** "Lower third", "Lower third and Kicker", or "Lower third and 3 more clips". */
async function editedClips(input: unknown, names?: ToolNames) {
  const batch = CommandBatchSchema.pick({
    commands: true,
    composition: true,
  }).safeParse(input);
  if (!batch.success) return undefined;
  const { commands, composition } = batch.data;
  const ids = [...new Set(commands.flatMap(clipsOf))];
  const known = ids.length
    ? await names?.clips(composition).catch(() => undefined)
    : undefined;
  const labels = ids.map((id) => {
    const clip = known?.get(id);
    return clip?.label?.trim() || (clip?.src ? fileName(clip.src) : undefined);
  });
  const named = [
    ...new Set([
      ...labels.flatMap((label) => label ?? []),
      ...commands.flatMap((command) =>
        command.type === "insert"
          ? [command.clip.label ?? fileName(command.clip.src)]
          : [],
      ),
    ]),
  ];
  // A clip the timeline cannot name is counted, never shown by its id.
  const unnamed = labels.filter((label) => !label).length;
  const [first, second] = named;
  if (!first) {
    if (!ids.length) return undefined;
    if (ids.length > 1) return `${ids.length} clips`;
    const kind = known?.get(ids[0])?.kind;
    if (!kind) return "a clip";
    return `a ${kind === "element" ? "text" : kind} clip`;
  }
  const more = named.length - 1 + unnamed;
  if (!more) return first;
  if (second && more === 1) return `${first} and ${second}`;
  return `${first} and ${more} more ${more === 1 ? "clip" : "clips"}`;
}

/**
 * What one of Cutroom's own tool calls acts on, in the editor's words: a file, the clips an edit
 * touches, a note's first words. Used for both the transcript row and the approval question,
 * so they always name the same thing. Other servers' and native tools have no subject here.
 */
export async function toolSubject(
  tool: string,
  input: unknown,
  names?: ToolNames,
): Promise<string | undefined> {
  const { server, name } = parseTool(tool);
  if (server !== CUTROOM_SERVER) return undefined;
  const args = z.record(z.string(), z.unknown()).safeParse(input).data ?? {};
  const text = (key: string) => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  switch (name) {
    case "source_read":
    case "source_write":
      return text("path");
    case "media_rename":
    case "media_remove": {
      const media = text("path");
      return media && fileName(media);
    }
    case "project_create": {
      const title = text("name");
      return title && `“${title}”`;
    }
    case "project_import":
      return text("path");
    case "transcription_start":
    case "transcript_import": {
      const media = text("mediaPath");
      return media && fileName(media);
    }
    case "transcript_edit": {
      const id = text("transcriptId");
      return id ? names?.transcript(id).catch(() => undefined) : undefined;
    }
    case "timeline_edit":
      return editedClips(args, names);
    default: {
      const id = text("noteId") ?? text("annotationId");
      return id ? names?.note(id).catch(() => undefined) : undefined;
    }
  }
}
