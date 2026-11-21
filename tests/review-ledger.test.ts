import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  acceptMembers,
  appendEdit,
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
