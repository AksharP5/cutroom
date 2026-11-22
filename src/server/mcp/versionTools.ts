import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MAX_VERSIONS,
  TimelineViewSchema,
  VersionNameSchema,
  VersionsSchema,
} from "../../shared/timeline/schema";
import type {
  Clip,
  CommandInput,
  Fps,
  TimelineView,
} from "../../shared/timeline/schema";
import { activeVersion, mediaVersions } from "../../shared/timeline/versions";
import type { RequestOptions } from "./server";
import { agentVersions, editReply } from "./timelineReply";

type ReadView = (
  projectId: string,
  composition: string,
) => Promise<
  { ok: true; view: TimelineView } | { ok: false; failure: CallToolResult }
>;
type JsonRequest = (
  path: string,
  method: string,
  body: unknown,
  options: RequestOptions,
) => Promise<CallToolResult>;

const refused = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const target = {
  projectId: z.string().describe("Project ID returned by projects_list"),
  composition: z
    .string()
    .default("index.html")
    .describe("Composition file within the project"),
  clipId: z.string().min(1).max(200),
};
const pick = z
  .union([
    z
      .number()
      .int()
      .nonnegative()
      .max(MAX_VERSIONS - 1),
    VersionNameSchema,
  ])
  .describe("The version's number in the list (0 is the first) or its name");

/** A clip's versions as an agent reads them. */
const listing = (clip: Clip, fps: Fps) => ({
  clipId: clip.id,
  kind: clip.kind,
  start: clip.start,
  duration: clip.duration,
  track: clip.track,
  active: activeVersion(clip),
  versions: agentVersions(clip.versions ?? [], fps).map((version, index) => ({
    index,
    ...version,
  })),
});

/**
 * Versions: one clip holding several alternatives, such as five animations of one line, with
 * one shown. Each tool is one undo step on the shared command path.
 */
export function registerVersionTools(
  server: Pick<McpServer, "registerTool">,
  readView: ReadView,
  request: JsonRequest,
) {
  /** Applies the commands as one undo step and answers with what changed. */
  const commit = (
    projectId: string,
    before: TimelineView,
    label: string,
    commands: CommandInput[],
    extra: object = {},
  ) =>
    request(
      `/projects/${encodeURIComponent(projectId)}/commands`,
      "POST",
      {
        composition: before.composition,
        expectedRevision: before.revision,
        label,
        commands,
      },
      {
        reply: (result) => ({
          ...extra,
          ...editReply(before, TimelineViewSchema.parse(result), false),
        }),
      },
    );
  const edits = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  };
  /** The clip and its view, or the refusal to show the agent. */
  const find = async (
    projectId: string,
    composition: string,
    clipId: string,
  ) => {
    const read = await readView(projectId, composition);
    if (!read.ok) return read;
    const clip = read.view.timeline.clips.find(({ id }) => id === clipId);
    if (!clip)
      return {
        ok: false as const,
        failure: refused(`No clip has id ${clipId} in ${composition}.`),
      };
    return { ok: true as const, view: read.view, clip };
  };
  const indexOf = (clip: Clip, version: number | string) => {
    const versions = clip.versions ?? [];
    const index =
      typeof version === "number"
        ? version
        : versions.findIndex(({ name }) => name === version);
    return versions[index] ? index : null;
  };

  server.registerTool(
    "clip_versions_set",
    {
      description:
        "Give one clip several versions to choose between, for \"give me 5 versions of this\": write each version as its own composition file first (source_write, e.g. compositions/title-orbit.html, each a full scene the clip's length), then call this once with all of them. The owner sees a versions badge on the clip, previews each in the viewer and keeps one; only the active version plays in preview and export. A scene clip takes composition files. A title or text clip becomes a scene clip in its place, with the same track, start, length and name; the reply names its new id. An image clip takes image files. Footage and audio take media of the same kind, with an optional sourceIn in source seconds (default: the clip's In for its own file, else 0). Send linked takes to the picture. Replaces any versions the clip had. One undo step.",
      inputSchema: {
        ...target,
        versions: VersionsSchema.describe(
          `2 to ${MAX_VERSIONS} versions, each {name, src, sourceIn?}: a short distinct name the owner reads (such as "Card fan"), and the file as this composition writes it, from its folder`,
        ),
        active: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_VERSIONS - 1)
          .default(0)
          .describe("The version to show first"),
      },
      annotations: edits,
    },
    async ({ projectId, composition, clipId, versions, active }) => {
      const found = await find(projectId, composition, clipId);
      if (!found.ok) return found.failure;
      const { view, clip } = found;
      const label = `Versions of ${clip.label ?? clip.textPreview ?? clip.id}`;
      if (clip.kind !== "element")
        return commit(projectId, view, label, [
          { type: "setVersions", clipId, versions, active },
        ]);
      // A text or title clip gives way to a scene that plays the versions in its place.
      const id = `${clipId}-versions`;
      return commit(
        projectId,
        view,
        label,
        [
          { type: "remove", clipIds: [clipId] },
          {
            type: "insert",
            track: clip.track,
            at: clip.start,
            mode: "place",
            clip: {
              kind: "composition",
              id,
              src: versions[active]?.src ?? versions[0]!.src,
              duration: clip.duration,
              ...((clip.label ?? clip.textPreview) && {
                label: clip.label ?? clip.textPreview,
              }),
            },
          },
          { type: "setVersions", clipId: id, versions, active },
        ],
        { clipId: id },
      );
    },
  );
  server.registerTool(
    "clip_versions_list",
    {
      description:
        "List a clip's versions: each one's index, name and file, and which is active (shown in preview and export). active is -1 and versions empty when the clip has none.",
      inputSchema: target,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectId, composition, clipId }) => {
      const found = await find(projectId, composition, clipId);
      if (!found.ok) return found.failure;
      const result = listing(found.clip, found.view.timeline.fps);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { result },
      };
    },
  );
  for (const [name, type, description] of [
    [
      "clip_version_show",
      "setVersion",
      "Make another of a clip's versions the active one: it plays in preview and export, and the others stay on the clip to switch back to. One undo step.",
    ],
    [
      "clip_version_keep",
      "keepVersion",
      "Keep one of a clip's versions and drop the others from the clip, ending the choice. Their files stay in the project. Omit version to keep the active one. One undo step.",
    ],
  ] as const)
    server.registerTool(
      name,
      {
        description,
        inputSchema: {
          ...target,
          version: type === "setVersion" ? pick : pick.optional(),
        },
        annotations: edits,
      },
      async ({ projectId, composition, clipId, version }) => {
        const found = await find(projectId, composition, clipId);
        if (!found.ok) return found.failure;
        const { view, clip } = found;
        if (!clip.versions) return refused(`Clip ${clipId} has no versions.`);
        const index =
          version === undefined ? activeVersion(clip) : indexOf(clip, version);
        if (index === null)
          return refused(
            `Clip ${clipId} has no version ${JSON.stringify(version)}. Its versions are ${clip.versions.map(({ name }, at) => `${at} "${name}"`).join(", ")}.`,
          );
        const name = clip.versions[index]!.name;
        const label = mediaVersions(clip.kind)
          ? `${type === "setVersion" ? "Showed" : "Kept"} ${name} on ${clip.label ?? clip.src?.split("/").at(-1) ?? clip.id}`
          : `${type === "setVersion" ? "Show" : "Keep"} version "${name}"`;
        return commit(projectId, view, label, [
          { type, clipId, version: index },
        ]);
      },
    );
}
