import type { z } from "zod";
import type { PreviewLevelsSchema } from "../../shared/preview";

type Level = Pick<z.infer<typeof PreviewLevelsSchema>, "l" | "r" | "playing">;

/** Meter samples never enter React. Only the promoted preview may publish them. */
const listeners = new Set<(level: Level) => void>();
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
};
