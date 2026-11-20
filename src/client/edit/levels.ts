import type { z } from "zod";
import type { PreviewLevelsSchema } from "../../shared/preview";

type Levels = z.infer<typeof PreviewLevelsSchema>;
type Level = Pick<Levels, "l" | "r" | "playing"> &
  Partial<Pick<Levels, "strips" | "faders">>;

/** Meter samples never enter React. Only the promoted preview may publish them. */
const listeners = new Set<(level: Level) => void>();
const stripMeteringListeners = new Set<(enabled: boolean) => void>();
let stripMetering = false;
export const audioLevels = {
  publish(level: Level) {
    for (const listener of listeners) listener(level);
  },
  subscribe(listener: (level: Level) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  setStripMetering(enabled: boolean) {
    if (stripMetering === enabled) return;
    stripMetering = enabled;
    for (const listener of stripMeteringListeners) listener(enabled);
  },
  watchStripMetering(listener: (enabled: boolean) => void) {
    stripMeteringListeners.add(listener);
    listener(stripMetering);
    return () => {
      stripMeteringListeners.delete(listener);
    };
  },
};
