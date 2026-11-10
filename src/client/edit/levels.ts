import type { StereoLevel } from "@hyperframes/core/runtime/levelTap";

/** Meter samples never enter React. Only the promoted preview may publish them. */
const listeners = new Set<(level: StereoLevel) => void>();
export const audioLevels = {
  publish(level: StereoLevel) {
    for (const listener of listeners) listener(level);
  },
  subscribe(listener: (level: StereoLevel) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
