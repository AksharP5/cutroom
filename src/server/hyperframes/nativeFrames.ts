/** The decoder prints integer presentation times in the filter input's time base. */
export function nativeFrameClock(offset: number) {
  let pending = "";
  let timeBase = 0;
  const times: number[] = [];
  function record(chunk: string) {
    pending += chunk;
    let newline: number;
    while ((newline = pending.search(/[\r\n]/)) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.includes("showinfo")) continue;
      const basis = /config in time_base:\s*(\d+)\/(\d+)/.exec(line);
      if (basis) timeBase = Number(basis[1]) / Number(basis[2]);
      const frame = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)/.exec(line);
      if (frame && timeBase)
        times[Number(frame[1])] = Number(frame[2]) * timeBase + offset;
    }
  }
  function finish(count: number) {
    record("\n");
    const kept = times.slice(0, count);
    if (
      kept.length !== count ||
      [...kept].some((time) => !Number.isFinite(time))
    )
      throw new Error(
        "The native frame timestamps did not match the decoded video.",
      );
    return kept;
  }
  return { record, finish };
}
