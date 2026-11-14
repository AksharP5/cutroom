/** One refresh in flight and one replaceable destination. Saves and history stay in their
 * existing queues; only preview invalidations coalesce. A superseded snapshot is discarded.
 */
export function previewRefresh<T>(
  refresh: (value: T, latest: () => boolean) => Promise<void>,
  failed: (error: unknown) => void,
) {
  let pending: { value: T } | null = null;
  let running = false;
  let disposed = false;
  const drain = async () => {
    running = true;
    try {
      while (pending && !disposed) {
        const { value } = pending;
        pending = null;
        await refresh(value, () => !pending && !disposed);
      }
    } catch (error) {
      if (!disposed) failed(error);
    } finally {
      running = false;
      if (pending && !disposed) void drain();
    }
  };
  return {
    push(value: T) {
      pending = { value };
      if (!running && !disposed) void drain();
    },
    dispose() {
      disposed = true;
      pending = null;
    },
  };
}
