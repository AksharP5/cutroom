import { ZodError } from "zod";
import type { ProjectDocument } from "../../shared/project";
import { ProjectDocumentSchema } from "../../shared/project";
import { emptyTimelineSettings } from "../../shared/timeline/schema";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Value = Json | undefined;
type RecordValue = { [key: string]: Json };

const object = (value: Value): value is RecordValue =>
  value !== undefined &&
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value);

function keyed(value: Value, key: "id" | "index") {
  const rows = new Map<string | number, Json>();
  if (value === undefined) return rows;
  if (!Array.isArray(value)) return;
  for (const row of value) {
    if (!object(row)) return;
    const id = row[key];
    if (typeof id !== "number" && typeof id !== "string") return;
    if (rows.has(id)) return;
    rows.set(id, row);
  }
  return rows;
}

class Overlap extends Error {}

function reverse(
  before: Value,
  after: Value,
  current: Value,
  field?: string,
): Value {
  if (Bun.deepEquals(before, after)) return current;
  if (Bun.deepEquals(current, after)) return before;

  if (
    (before === undefined || object(before)) &&
    (after === undefined || object(after)) &&
    object(current)
  ) {
    const entries = Object.entries(current).filter(
      ([key]) =>
        !Object.hasOwn(after ?? {}, key) && !Object.hasOwn(before ?? {}, key),
    );
    for (const key of new Set([
      ...Object.keys(before ?? {}),
      ...Object.keys(after ?? {}),
    ])) {
      const get = (value: RecordValue | undefined) =>
        value && Object.hasOwn(value, key) ? value[key] : undefined;
      const value = reverse(get(before), get(after), get(current), key);
      if (value !== undefined) entries.push([key, value]);
    }
    return !before && !entries.length ? undefined : Object.fromEntries(entries);
  }

  const key = field === "tracks" ? "index" : "id";
  const b = keyed(before, key);
  const a = keyed(after, key);
  const c = keyed(current, key);
  if (!b || !a || !c || current === undefined) throw new Overlap();
  for (const id of new Set([...b.keys(), ...a.keys()])) {
    const value = reverse(b.get(id), a.get(id), c.get(id));
    if (value === undefined) {
      c.delete(id);
    } else if (c.has(id)) {
      c.set(id, value);
    } else {
      // Restore the row beside the nearest sibling still present.
      const order = [...b.keys()];
      const index = order.indexOf(id);
      const next = order.slice(index + 1).find((key) => c.has(key));
      const entries = [...c];
      entries.splice(
        next === undefined
          ? entries.length
          : entries.findIndex(([key]) => key === next),
        0,
        [id, value],
      );
      c.clear();
      for (const [key, row] of entries) c.set(key, row);
    }
  }
  return !before && !c.size ? undefined : [...c.values()];
}

export function reverseDocument(
  before: ProjectDocument,
  after: ProjectDocument,
  current: ProjectDocument,
) {
  try {
    const documents = [before, after, current].map((document) => ({
      ...document,
      timelines: { ...document.timelines },
    }));
    const compositions = new Set(
      documents.flatMap(({ timelines }) => Object.keys(timelines)),
    );
    for (const { timelines } of documents)
      for (const composition of compositions)
        if (!Object.hasOwn(timelines, composition))
          Object.defineProperty(timelines, composition, {
            value: emptyTimelineSettings(),
            enumerable: true,
            writable: true,
            configurable: true,
          });
    const document = reverse(documents[0], documents[1], documents[2]);
    const parsed = ProjectDocumentSchema.parse(document);
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch (error) {
    if (error instanceof Overlap || error instanceof ZodError) return null;
    throw error;
  }
}
