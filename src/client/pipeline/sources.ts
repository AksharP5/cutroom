/**
 * One open per file. A file that failed to open stays failed until `forgetFailures`, which the
 * pipeline calls with each new plan, so a broken file is not fetched again on every frame.
 */
export function sourceCache<T>(open: (path: string) => Promise<T>) {
  const opened = new Map<string, Promise<T>>();
  const failed = new Set<string>();
  return {
    get(path: string) {
      let found = opened.get(path);
      if (!found) {
        found = open(path);
        const loading = found;
        loading.catch(() => {
          if (opened.get(path) === loading) failed.add(path);
        });
        opened.set(path, found);
      }
      return found;
    },
    forgetFailures() {
      for (const path of failed) opened.delete(path);
      failed.clear();
    },
    remove(path: string) {
      const found = opened.get(path);
      opened.delete(path);
      failed.delete(path);
      return found;
    },
    values: () => opened.values(),
  };
}
