import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ClipEditSchema } from "../../shared/timeline/schema";
import { missingSignature } from "./changes";

export const LegacyEditSchema = ClipEditSchema.omit({
  resolution: true,
}).extend({
  signature: z.string().optional(),
  beforeSignature: z.string().optional(),
  noteIds: z.array(z.string()).default([]),
});
type LegacyEdit = z.infer<typeof LegacyEditSchema>;
type ClipEdit = z.infer<typeof ClipEditSchema>;

const index = z.number().int().nonnegative();
const overrides = z.record(z.string(), z.number().int().min(-1));
const targetSchema = z.object({
  composition: z.string(),
  clipId: z.string().nullable(),
  // The ordinary case is one pre-agent signature. Older baselines stay addressable
  // when acceptance, undo, or a return to source gives later work a different one.
  baselines: z.array(z.string()),
});
const entrySchema = ClipEditSchema.pick({
  id: true,
  historyId: true,
  by: true,
  agentName: true,
  at: true,
  label: true,
}).extend({
  noteIds: z.array(z.string()),
  // Ordered catalog indexes. A pair denotes an inclusive run of adjacent indexes.
  touched: z.array(z.union([index, z.tuple([index, index])])),
  accepted: z.union([z.literal(true), z.array(index)]).optional(),
  before: overrides.optional(),
  // Consecutive SHA-256 digests, one per touched target. Legacy signatures,
  // missing clips and omitted signatures can override individual slots.
  after: z.string().optional(),
  otherAfter: z.record(z.string(), z.string().nullable()).optional(),
  legacyIds: z.record(z.string(), z.string()).optional(),
  labels: z.record(z.string(), z.string()).optional(),
  batches: z.record(z.string(), z.array(z.string())).optional(),
});

export const LedgerSchema = z
  .object({
    targets: z.array(targetSchema),
    edits: z.array(entrySchema),
  })
  .refine(
    ({ targets, edits }) =>
      edits.every((edit) => {
        let count = 0;
        for (const run of edit.touched) {
          const [first, last] = typeof run === "number" ? [run, run] : run;
          if (first > last || last >= targets.length) return false;
          count += last - first + 1;
        }
        return (
          count > 0 &&
          (edit.after === undefined ||
            (/^[A-Za-z0-9+/]+=*$/.test(edit.after) &&
              Buffer.byteLength(edit.after, "base64") === count * 32))
        );
      }),
    "Invalid review membership",
  );

export type Ledger = z.infer<typeof LedgerSchema>;
export type Entry = Ledger["edits"][number];
type Target = Ledger["targets"][number];
export type Member = {
  entry: Entry;
  target: Target;
  index: number;
  ordinal: number;
  accepted: boolean;
};

export function* members(ledger: Ledger, entry: Entry): Generator<Member> {
  const accepted = new Set(entry.accepted === true ? [] : entry.accepted);
  let ordinal = 0;
  for (const run of entry.touched) {
    const [first, last] = typeof run === "number" ? [run, run] : run;
    for (let index = first; index <= last; index++) {
      yield {
        entry,
        target: ledger.targets[index]!,
        index,
        ordinal,
        accepted: entry.accepted === true || accepted.has(ordinal),
      };
      ordinal++;
    }
  }
}

const indexedTargets = (ledger: Ledger) =>
  new Map(
    ledger.targets.map((target, index) => [
      JSON.stringify([target.composition, target.clipId]),
      index,
    ]),
  );
function addTarget(
  ledger: Ledger,
  indexes: Map<string, number>,
  composition: string,
  clipId: string | null,
) {
  const key = JSON.stringify([composition, clipId]);
  const found = indexes.get(key);
  if (found !== undefined) return found;
  const index = ledger.targets.length;
  ledger.targets.push({ composition, clipId, baselines: [] });
  indexes.set(key, index);
  return index;
}

/** Named by the clip, not its catalog index, so compaction never renames a row. */
export function memberId({ entry, ordinal, target }: Member) {
  return (
    entry.legacyIds?.[ordinal] ??
    `${entry.id}:${target.composition}:${target.clipId}`
  );
}
function beforeSignature({ entry, target, ordinal }: Member) {
  return target.baselines[entry.before?.[ordinal] ?? 0];
}
const afterBuffers = new WeakMap<Entry, Buffer>();
function afterSignature({ entry, ordinal }: Member) {
  const alternate = entry.otherAfter?.[ordinal];
  if (alternate !== undefined) return alternate ?? undefined;
  if (!entry.after) return undefined;
  let bytes = afterBuffers.get(entry);
  if (!bytes) {
    bytes = Buffer.from(entry.after, "base64");
    afterBuffers.set(entry, bytes);
  }
  return `v3:${bytes.toString("hex", ordinal * 32, (ordinal + 1) * 32)}`;
}
const comparable = ({ entry, ordinal }: Member) =>
  entry.otherAfter && ordinal in entry.otherAfter
    ? entry.otherAfter[ordinal]?.startsWith("v3:") === true
    : entry.after !== undefined;
export const pending = (member: Member) =>
  member.entry.by === "agent" && !member.accepted;

export function sourceResolved(member: Member, version: string | undefined) {
  return (
    comparable(member) &&
    beforeSignature(member) === (version ?? missingSignature)
  );
}

export function describeMember(member: Member, resolved: boolean): ClipEdit {
  const { entry, ordinal, target, accepted } = member;
  return {
    id: memberId(member),
    clipId: target.clipId,
    composition: target.composition,
    label: entry.labels?.[ordinal] ?? entry.label,
    batchLabels: entry.batches?.[ordinal],
    historyId: entry.historyId,
    by: entry.by,
    agentName: entry.agentName,
    at: entry.at,
    accepted,
    resolution: resolved ? "source" : undefined,
  };
}

export function* activeEntries(ledger: Ledger, undone: ReadonlySet<string>) {
  for (const entry of ledger.edits)
    if (entry.historyId === undefined || !undone.has(entry.historyId))
      yield entry;
}

const entryCompositions = new WeakMap<Entry, ReadonlySet<string>>();
export function compositionsOf(
  ledger: Ledger,
  entry: Entry,
): ReadonlySet<string> {
  let paths = entryCompositions.get(entry);
  if (!paths) {
    paths = new Set(
      [...members(ledger, entry)].map((member) => member.target.composition),
    );
    entryCompositions.set(entry, paths);
  }
  return paths;
}

function rememberBaseline(target: Target, signature: string | undefined) {
  if (signature === undefined) return -1;
  const known = target.baselines.indexOf(signature);
  if (known !== -1) return known;
  return target.baselines.push(signature) - 1;
}

type WriteMember = {
  index: number;
  id?: string;
  before?: string;
  after?: string;
  accepted: boolean;
  label?: string;
  batchLabels?: string[];
};

function writeMembers(
  ledger: Ledger,
  metadata: Omit<Entry, "touched">,
  rows: WriteMember[],
): Entry {
  const entry: Entry = { ...metadata, touched: [] };
  const bytes = Buffer.alloc(rows.length * 32);
  let hasDigests = false;
  const accepted: number[] = [];
  rows.forEach((row, ordinal) => {
    const last = entry.touched.at(-1);
    if (typeof last === "number" && last + 1 === row.index)
      entry.touched[entry.touched.length - 1] = [last, row.index];
    else if (Array.isArray(last) && last[1] + 1 === row.index)
      last[1] = row.index;
    else entry.touched.push(row.index);

    // Only agent work is compared with the state before it; the owner's rows need no baseline.
    if (metadata.by === "agent") {
      const before = rememberBaseline(ledger.targets[row.index]!, row.before);
      if (before !== 0) (entry.before ??= {})[ordinal] = before;
    }
    if (row.after && /^v3:[a-f0-9]{64}$/.test(row.after)) {
      bytes.write(row.after.slice(3), ordinal * 32, 32, "hex");
      hasDigests = true;
    } else {
      (entry.otherAfter ??= {})[ordinal] = row.after ?? null;
    }
    if (row.id !== undefined) (entry.legacyIds ??= {})[ordinal] = row.id;
    if (row.label !== undefined && row.label !== entry.label)
      (entry.labels ??= {})[ordinal] = row.label;
    if (row.batchLabels) (entry.batches ??= {})[ordinal] = row.batchLabels;
    if (row.accepted) accepted.push(ordinal);
  });
  if (hasDigests) entry.after = bytes.toString("base64");
  else if (rows.every((row) => row.after === undefined))
    delete entry.otherAfter;
  if (accepted.length)
    entry.accepted = accepted.length === rows.length ? true : accepted;
  return entry;
}

/** Adds rows from a version 1 review.json to `ledger`, skipping rows it already holds. */
export function migrateLedger(
  edits: LegacyEdit[],
  changes: {
    composition: string;
    clipId: string;
    signature: string;
    noteIds: string[];
  }[],
  ledger: Ledger = { targets: [], edits: [] },
): Ledger {
  // Older files can still carry the marks from before per-edit review.
  const open = new Map<string, LegacyEdit[]>();
  for (const edit of edits) {
    if (edit.accepted) continue;
    const key = JSON.stringify([edit.composition, edit.clipId]);
    const rows = open.get(key);
    if (rows) rows.push(edit);
    else open.set(key, [edit]);
  }
  for (const change of changes) {
    const rows = open.get(JSON.stringify([change.composition, change.clipId]));
    const latest = rows?.at(-1);
    if (latest) {
      latest.signature ??= change.signature;
      for (const row of rows!) row.noteIds = change.noteIds;
      continue;
    }
    const row: LegacyEdit = {
      ...change,
      id: `legacy:${change.composition}:${change.clipId}:${change.signature}`,
      label: "Edited source",
      by: "agent",
      at: "",
      accepted: false,
    };
    edits.push(row);
    open.set(JSON.stringify([change.composition, change.clipId]), [row]);
  }

  const moved = new Set(
    ledger.edits.flatMap((entry) => Object.values(entry.legacyIds ?? {})),
  );
  const indexes = indexedTargets(ledger);
  let previous: string | undefined;
  let metadata: Omit<Entry, "touched"> | undefined;
  let rows: WriteMember[] = [];
  for (const edit of edits) {
    if (moved.has(edit.id)) continue;
    const { historyId, at, by, agentName, noteIds } = edit;
    const key = JSON.stringify([
      historyId ?? edit.id,
      at,
      by,
      agentName,
      noteIds,
    ]);
    if (key !== previous) {
      if (metadata) ledger.edits.push(writeMembers(ledger, metadata, rows));
      metadata = {
        id: randomUUID(),
        historyId,
        at,
        by,
        agentName,
        noteIds,
        label: edit.label,
      };
      rows = [];
      previous = key;
    }
    rows.push({
      index: addTarget(ledger, indexes, edit.composition, edit.clipId),
      id: edit.id,
      before: edit.beforeSignature,
      after: edit.signature,
      accepted: edit.accepted,
      label: edit.label,
      batchLabels: edit.batchLabels,
    });
  }
  if (metadata) ledger.edits.push(writeMembers(ledger, metadata, rows));
  return ledger;
}

export function appendEdit(
  ledger: Ledger,
  metadata: Omit<Entry, "id" | "touched">,
  rows: (Omit<WriteMember, "index" | "id"> & {
    composition: string;
    clipId: string | null;
  })[],
  batchLabels?: string[],
) {
  const indexes = indexedTargets(ledger);
  const recorded = new Set(
    ledger.edits
      .filter(
        (edit) =>
          metadata.historyId !== undefined &&
          edit.historyId === metadata.historyId,
      )
      .flatMap((edit) =>
        [...members(ledger, edit)].map((member) => member.index),
      ),
  );
  const added = rows.flatMap(({ composition, clipId, ...row }) => {
    const index = addTarget(ledger, indexes, composition, clipId);
    return recorded.has(index) ? [] : [{ ...row, index }];
  });
  const last = added.at(-1);
  if (last) {
    last.batchLabels = batchLabels;
    ledger.edits.push(
      writeMembers(ledger, { id: randomUUID(), ...metadata }, added),
    );
  }
  // Keep the existing retention rule for settled review display rows.
  let kept = 0;
  ledger.edits = ledger.edits
    .reduceRight<Entry[]>((entries, entry) => {
      if (entry.by === "agent" && !entry.accepted) {
        entries.push(entry);
        return entries;
      }
      const rows = [...members(ledger, entry)]
        .reverse()
        .filter((member) => pending(member) || kept++ < 200)
        .reverse();
      if (!rows.length) return entries;
      if (rows.length === memberCount(entry)) entries.push(entry);
      else {
        const { id, historyId, by, agentName, at, label, noteIds } = entry;
        entries.push(
          writeMembers(
            ledger,
            { id, historyId, by, agentName, at, label, noteIds },
            rows.map((member) => ({
              index: member.index,
              id: entry.legacyIds?.[member.ordinal],
              before: beforeSignature(member),
              after: afterSignature(member),
              accepted: member.accepted,
              label: entry.labels?.[member.ordinal],
              batchLabels: entry.batches?.[member.ordinal],
            })),
          ),
        );
      }
      return entries;
    }, [])
    .reverse();
  compact(ledger);
}

/**
 * Drops targets and baselines that no remaining row refers to, so accepting agent work and editing
 * again does not grow the file. It runs once the unused part outweighs the used part, so the file
 * stays within about twice its live size.
 */
function compact(ledger: Ledger) {
  const used = new Map<number, Set<number>>();
  for (const entry of ledger.edits)
    for (const { index, ordinal } of members(ledger, entry)) {
      const baselines = used.get(index) ?? new Set<number>();
      used.set(index, baselines);
      const before = entry.before?.[ordinal] ?? 0;
      if (entry.by === "agent" && before !== -1) baselines.add(before);
    }
  const kept = [...used.values()].reduce((sum, set) => sum + set.size + 1, 0);
  const total = ledger.targets.reduce(
    (sum, target) => sum + target.baselines.length + 1,
    0,
  );
  if (total - kept <= kept + 256) return;

  const targets = new Map<number, number>();
  const baselines = new Map<number, Map<number, number>>();
  const next: Ledger["targets"] = [];
  ledger.targets.forEach((target, index) => {
    const referenced = used.get(index);
    if (!referenced) return;
    targets.set(index, next.length);
    const renumbered = new Map<number, number>();
    const signatures: string[] = [];
    target.baselines.forEach((signature, old) => {
      if (!referenced.has(old)) return;
      renumbered.set(old, signatures.length);
      signatures.push(signature);
    });
    baselines.set(index, renumbered);
    next.push({ ...target, baselines: signatures });
  });
  // Kept indexes keep their order, so every run stays a run and every ordinal keeps its meaning.
  ledger.edits = ledger.edits.map((entry) => {
    const before: Record<string, number> = {};
    if (entry.by === "agent")
      for (const { index, ordinal } of members(ledger, entry)) {
        const old = entry.before?.[ordinal] ?? 0;
        const renumbered = old === -1 ? -1 : baselines.get(index)!.get(old)!;
        if (renumbered !== 0) before[ordinal] = renumbered;
      }
    return {
      ...entry,
      touched: entry.touched.map((run) =>
        typeof run === "number"
          ? targets.get(run)!
          : [targets.get(run[0])!, targets.get(run[1])!],
      ),
      before: Object.keys(before).length ? before : undefined,
    };
  });
  ledger.targets = next;
}

function memberCount(entry: Entry) {
  return entry.touched.reduce<number>(
    (count, run) => count + (typeof run === "number" ? 1 : run[1] - run[0] + 1),
    0,
  );
}

/**
 * Earlier acceptances establish the accepted bytes for later pending work on that target.
 * `settled` rows are marked accepted without that: their clip is back to its state before the
 * agent, so their after bytes say nothing about later work.
 */
export function acceptMembers(
  ledger: Ledger,
  selections: ReadonlyMap<Entry, ReadonlySet<number>>,
  settled: ReadonlyMap<Entry, ReadonlySet<number>> = new Map(),
) {
  if (!selections.size && !settled.size) return;
  const baselines = new Map<number, string>();
  ledger.edits = ledger.edits.map((entry) => {
    if (entry.accepted === true || entry.by === "human") return entry;
    const selected = selections.get(entry);
    const quiet = settled.get(entry);
    if (!selected && !quiet && !baselines.size) return entry;
    const accepted = new Set(entry.accepted);
    const before = { ...entry.before };
    let changed = false;
    for (const member of members(ledger, entry)) {
      if (member.accepted) continue;
      if (selected?.has(member.ordinal)) {
        if (comparable(member))
          baselines.set(member.index, afterSignature(member)!);
        accepted.add(member.ordinal);
        changed = true;
        continue;
      }
      if (quiet?.has(member.ordinal)) {
        accepted.add(member.ordinal);
        changed = true;
        continue;
      }
      const baseline = baselines.get(member.index);
      if (
        baseline === undefined ||
        !comparable(member) ||
        beforeSignature(member) === baseline
      )
        continue;
      const index = rememberBaseline(member.target, baseline);
      if (index === 0) delete before[member.ordinal];
      else before[member.ordinal] = index;
      changed = true;
    }
    return changed
      ? {
          ...entry,
          before: Object.keys(before).length ? before : undefined,
          accepted: accepted.size === memberCount(entry) ? true : [...accepted],
        }
      : entry;
  });
}

export function pendingBaselines(
  ledger: Ledger,
  entries: Iterable<Entry>,
  composition: string,
  versions: ReadonlyMap<string | null, string>,
) {
  const baselines = new Map<string | null, string>();
  for (const entry of entries) {
    if (entry.by !== "agent" || entry.accepted === true) continue;
    for (const member of members(ledger, entry)) {
      const { target } = member;
      if (
        target.composition !== composition ||
        !pending(member) ||
        !comparable(member) ||
        baselines.has(target.clipId)
      )
        continue;
      const baseline = beforeSignature(member);
      if (
        baseline !== undefined &&
        !sourceResolved(member, versions.get(target.clipId))
      )
        baselines.set(target.clipId, baseline);
    }
  }
  return baselines;
}
