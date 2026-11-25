import { z } from "zod";
import { VariableValuesSchema } from "./variables";

/**
 * The Library: HyperFrames registry blocks and components, read at the tag of the HyperFrames
 * version Cutroom pins, so what it previews is what the installed runtime plays.
 */
export const LIBRARY_CATEGORIES = [
  { id: "titles", label: "Titles" },
  { id: "lower-thirds", label: "Lower thirds" },
  { id: "transitions", label: "Transitions" },
  { id: "text-effects", label: "Text effects" },
  { id: "captions", label: "Captions" },
  { id: "effects", label: "Effects" },
  { id: "overlays", label: "Overlays" },
  { id: "data", label: "Data" },
  { id: "scenes", label: "Scenes" },
  { id: "vfx", label: "VFX" },
] as const;
export const LibraryCategorySchema = z.enum(
  LIBRARY_CATEGORIES.map(({ id }) => id) as [
    (typeof LIBRARY_CATEGORIES)[number]["id"],
    ...(typeof LIBRARY_CATEGORIES)[number]["id"][],
  ],
);
export type LibraryCategory = z.infer<typeof LibraryCategorySchema>;

/** How long a component, which has no length of its own, runs once added. */
export const COMPONENT_SECONDS = 3;

export const LibraryNameSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Use a library item name.");

/** One item as the panel and agents see it. */
export const LibraryItemSchema = z.object({
  name: LibraryNameSchema,
  title: z.string(),
  kind: z.enum(["block", "component"]),
  category: LibraryCategorySchema,
  description: z.string(),
  tags: z.array(z.string()),
  /** Seconds, for blocks. */
  duration: z.number().positive().optional(),
  dimensions: z
    .object({ width: z.number().int(), height: z.number().int() })
    .optional(),
  hasPoster: z.boolean(),
  variables: z.array(
    z.object({ id: z.string(), type: z.string(), default: z.unknown() }),
  ),
  /** Its files are in Cutroom's cache, so it can be added offline. */
  cached: z.boolean(),
  /** Why it cannot be added, such as a newer HyperFrames; absent when it can. */
  disabled: z.string().optional(),
  /** Deprecated or too new: listed only to a search for its exact name. */
  hidden: z.boolean().optional(),
});
export type LibraryItem = z.infer<typeof LibraryItemSchema>;

export const LibraryCatalogSchema = z.object({
  /** The registry tag the list was read at. */
  ref: z.string(),
  items: z.array(LibraryItemSchema),
  /** When the list was saved, as an ISO date. */
  savedAt: z.string(),
  /** The registry could not be reached, so this is the saved list. */
  offline: z.boolean(),
});
export type LibraryCatalog = z.infer<typeof LibraryCatalogSchema>;

export const LibrarySearchSchema = z.object({
  query: z
    .string()
    .trim()
    .max(200)
    .default("")
    .describe("Words matched against title, name, tags and description"),
  category: LibraryCategorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  composition: z
    .string()
    .min(1)
    .max(2_000)
    .default("index.html")
    .describe("The timeline whose frame rate lengths are given in"),
});

export const LibraryAddSchema = z.object({
  name: LibraryNameSchema.describe("The item's name, from library_search"),
  composition: z
    .string()
    .min(1)
    .max(2_000)
    .default("index.html")
    .describe("The timeline to place it on"),
  track: z
    .number()
    .int()
    .min(0)
    .describe("Video track index, as timeline_read numbers them"),
  at: z.number().int().min(0).describe("Start frame"),
  start: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .optional()
    .describe(
      "Frames into the item where the clip begins, for a part marked from its In point; the clip keeps its place and length",
    ),
  mode: z.enum(["insert", "overwrite"]).default("overwrite"),
  duration: z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .optional()
    .describe(
      "Frames to place from the item's In point to its end at most. When omitted, places the rest of the item.",
    ),
  variables: VariableValuesSchema.optional().describe(
    "Values for the item's variables on this clip; the rest keep their defaults",
  ),
});
export type LibraryAdd = z.input<typeof LibraryAddSchema>;

export const LibraryAddedSchema = z.object({
  clipId: z.string(),
  /** The scene file the clip plays. */
  composition: z.string(),
  /** Files this add wrote; files the project already had unchanged are reused. */
  added: z.array(z.string()),
  /** Files the project had edited, kept as they are. */
  kept: z.array(z.string()),
  /** Every file the clip plays from, by its version as the project listing gives it. */
  versions: z.record(z.string(), z.string()),
  historyId: z.string().optional(),
});
export type LibraryAdded = z.infer<typeof LibraryAddedSchema>;

/** Registry titles are written with em dashes; the editor's copy uses commas. */
export const libraryTitle = (title: string) =>
  title.replace(/\s*[—–]\s*/g, ", ");

/** Every word of the query appears in the item's title, name, tags or description. */
export function librarySearch(query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (
    item: Pick<LibraryItem, "title" | "name" | "tags" | "description">,
  ) => {
    const text =
      `${item.title} ${libraryTitle(item.title)} ${item.name} ${item.tags.join(" ")} ${item.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  };
}
