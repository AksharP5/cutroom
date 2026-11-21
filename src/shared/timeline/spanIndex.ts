/** Finds the half-open spans containing a time. Results are reused until a boundary is crossed. */
export function spanIndex<T extends { start: number; end: number }>(
  spans: readonly T[],
) {
  type Node = {
    split: number;
    byStart: T[];
    byEnd: T[];
    left: Node | null;
    right: Node | null;
  };
  const sorted = spans
    .filter(({ start, end }) => start < end)
    .sort((a, b) => a.start - b.start);
  const boundaries = [
    ...new Set(sorted.flatMap(({ start, end }) => [start, end])),
  ].sort((a, b) => a - b);
  const build = (items: T[]): Node | null => {
    if (!items.length) return null;
    const split = items[Math.floor(items.length / 2)]!.start;
    const left: T[] = [];
    const right: T[] = [];
    const byStart: T[] = [];
    for (const span of items) {
      if (span.end <= split) left.push(span);
      else if (span.start > split) right.push(span);
      else byStart.push(span);
    }
    return {
      split,
      byStart,
      byEnd: byStart.toSorted((a, b) => b.end - a.end),
      left: build(left),
      right: build(right),
    };
  };
  const root = build(sorted);
  let from = Infinity;
  let until = -Infinity;
  let active: T[] = [];
  return (time: number): readonly T[] => {
    if (time >= from && time < until) return active;
    let low = 0;
    let high = boundaries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (boundaries[mid]! <= time) low = mid + 1;
      else high = mid;
    }
    from = boundaries[low - 1] ?? -Infinity;
    until = boundaries[low] ?? Infinity;
    active = [];
    for (let node = root; node;) {
      if (time < node.split) {
        for (const span of node.byStart) {
          if (span.start > time) break;
          active.push(span);
        }
        node = node.left;
      } else {
        for (const span of node.byEnd) {
          if (span.end <= time) break;
          active.push(span);
        }
        node = node.right;
      }
    }
    return active;
  };
}
