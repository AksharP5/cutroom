/** One seek in flight, one replaceable destination, and at most one start per paint. */
export function seekQueue<T>(
  seek: (value: T) => Promise<void>,
  failed: (error: unknown) => void,
  schedule = requestAnimationFrame,
  cancel = cancelAnimationFrame,
) {
  let latest: { value: T } | null = null;
  let running = false;
  let frame = 0;
  let disposed = false;
  const queue = () => {
    if (disposed || running || frame || !latest) return;
    frame = schedule(() => {
      frame = 0;
      const next = latest;
      latest = null;
      if (!next || disposed) return;
      running = true;
      void seek(next.value)
        .catch(failed)
        .finally(() => {
          running = false;
          queue();
        });
    });
  };
  return {
    push(value: T) {
      latest = { value };
      queue();
    },
    dispose() {
      disposed = true;
      latest = null;
      cancel(frame);
    },
  };
}
