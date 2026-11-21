export async function waitFor(
  assertion: () => void,
  { timeout = 1_000, interval = 10 } = {},
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (performance.now() >= deadline) throw error;
      await Bun.sleep(interval);
    }
  }
}
