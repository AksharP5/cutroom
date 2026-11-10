import type { NewId } from "../src/shared/timeline/apply";

/**
 * Names pieces by counting up from their source (`talk-2`, `talk-3`) so tests can spell the ids
 * they expect. Tests pass it on purpose; the app names pieces with `randomClipId`.
 */
export const countingIds: NewId = (base, from, taken) => {
  const stem = from === null ? base : base.replace(/-\d+$/, "");
  if (from === null && !taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
};
