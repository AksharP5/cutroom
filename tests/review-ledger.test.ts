import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  acceptMembers,
  appendEdit,
  memberId,
  members,
  pending,
} from "../src/server/projects/reviewLedger";
import type { Entry, Ledger } from "../src/server/projects/reviewLedger";

const signature = (...parts: unknown[]) =>
  `v3:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;

test("accepting every agent ripple keeps the ledger the size of one edit, not of every edit", () => {
  const clips = Array.from({ length: 1000 }, (_, index) => `clip-${index}`);
  const ledger: Ledger = { targets: [], edits: [] };
  const sizes: number[] = [];
  for (let cycle = 0; cycle < 250; cycle++) {
    // An agent ripple moves every clip; the owner then accepts all of it.
    appendEdit(
      ledger,
      {
        historyId: `history-${cycle}`,
        label: "Ripple delete",
        at: new Date(cycle * 1000).toISOString(),
        by: "agent",
        agentName: "Agent",
        noteIds: [],
      },
      clips.map((clipId) => ({
        composition: "index.html",
        clipId,
        before: signature(cycle, clipId),
        after: signature(cycle + 1, clipId),
        accepted: false,
      })),
    );
    const selections = new Map<Entry, Set<number>>();
    for (const entry of ledger.edits)
      for (const member of members(ledger, entry))
        if (pending(member))
          selections.set(
            entry,
            (selections.get(entry) ?? new Set()).add(member.ordinal),
          );
    acceptMembers(ledger, selections);
    sizes.push(JSON.stringify(ledger).length);
  }
  expect(
    ledger.edits
      .flatMap((entry) => [...members(ledger, entry)])
      .filter(pending),
  ).toEqual([]);
  // One ripple's rows and baselines, plus the 200 settled rows kept for Changes.
  const settled = Math.max(...sizes.slice(0, 10));
  expect(sizes.at(-1)!).toBeLessThan(settled * 3);
  expect(Math.max(...sizes)).toBeLessThan(settled * 3);
});

test("the owner's edits store no baseline for review", () => {
  const ledger: Ledger = { targets: [], edits: [] };
  appendEdit(
    ledger,
    { label: "Ripple delete", at: "", by: "human", noteIds: [] },
    Array.from({ length: 1000 }, (_, index) => ({
      composition: "index.html",
      clipId: `clip-${index}`,
      accepted: true,
    })),
  );
  expect(ledger.edits[0]!.before).toBeUndefined();
  expect(ledger.targets.every((target) => !target.baselines.length)).toBe(true);
});

test("a pending row keeps its id when compaction renumbers the clips before it", () => {
  const ledger: Ledger = { targets: [], edits: [] };
  const ripple = (by: "agent" | "human", prefix: string, accepted: boolean) =>
    appendEdit(
      ledger,
      { label: "Ripple delete", at: "", by, noteIds: [] },
      Array.from({ length: 1000 }, (_, index) => ({
        composition: "index.html",
        clipId: `${prefix}-${index}`,
        ...(by === "agent" && {
          before: signature(prefix, index),
          after: signature(prefix, index, "after"),
        }),
        accepted,
      })),
    );
  ripple("agent", "early", true);
  appendEdit(
    ledger,
    { label: "Set opacity", at: "", by: "agent", noteIds: [] },
    [
      {
        composition: "index.html",
        clipId: "title",
        before: signature("title"),
        after: signature("title", "after"),
        accepted: false,
      },
    ],
  );
  const waiting = () =>
    ledger.edits
      .flatMap((entry) => [...members(ledger, entry)])
      .filter(pending);
  const [before] = waiting();
  // The owner's later edits push the early rows out, so their targets are dropped.
  for (const prefix of ["later-1", "later-2", "later-3"])
    ripple("human", prefix, true);
  const [after] = waiting();
  expect(after!.index).not.toBe(before!.index);
  expect(memberId(after!)).toBe(memberId(before!));
});
