import { comboOf, keymap } from "../keymap";
import type { Direction, Transport, TransportEvent } from "./transport";

/** How long J or L stays down with K before a tap becomes a hold. */
export const HOLD_MS = 250;

/**
 * J, K and L as Resolve plays them together. Alone, J and L shuttle and K stops. While K is
 * held, a tap of J or L steps one frame that way, and holding it plays at half speed. Releasing
 * either key stops that half-speed play.
 */
export type Jog = {
  /** K is down. */
  stop: boolean;
  /** J or L is down. */
  held: Direction | null;
  /** Half-speed play is running. */
  slow: boolean;
};

export const idleJog: Jog = { stop: false, held: null, slow: false };

/** A step of one frame either way, or a transport event, or nothing. */
export type JogEffect =
  TransportEvent | { type: "step"; frames: 1 | -1 } | null;

const step = (dir: Direction): JogEffect => ({
  type: "step",
  frames: dir === "forward" ? 1 : -1,
});

/** A press of J or L (by direction) or K ("stop"). Key repeats never get here. */
export function jogPress(jog: Jog, key: Direction | "stop"): [Jog, JogEffect] {
  if (key === "stop") {
    // L already down, then K: half speed that way at once.
    if (jog.held)
      return [
        { ...jog, stop: true, slow: true },
        { type: "slow", dir: jog.held },
      ];
    return [{ ...jog, stop: true }, { type: "stop" }];
  }
  if (!jog.stop)
    return [
      { ...jog, held: key, slow: false },
      { type: "shuttle", dir: key, fast: false },
    ];
  return [{ ...jog, held: key, slow: false }, step(key)];
}

/** HOLD_MS after the latest press: J or L still down with K turns the step into half speed. */
export function jogHold(jog: Jog): [Jog, JogEffect] {
  if (!jog.stop || !jog.held || jog.slow) return [jog, null];
  return [
    { ...jog, slow: true },
    { type: "slow", dir: jog.held },
  ];
}

/** A release of J or L (by direction) or K. */
export function jogRelease(
  jog: Jog,
  key: Direction | "stop",
): [Jog, JogEffect] {
  if (key === "stop") {
    const next = { ...jog, stop: false, slow: false };
    return [next, jog.slow ? { type: "stop" } : null];
  }
  if (jog.held !== key) return [jog, null];
  return [
    { ...jog, held: null, slow: false },
    jog.slow ? { type: "stop" } : null,
  ];
}

type JogKey = Direction | "stop";

/** Which of J, L or K a key event is, by the physical key and whatever modifiers are held. */
export function jogKeyOf(event: Pick<KeyboardEvent, "code">): JogKey | null {
  const key = comboOf({
    code: event.code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  });
  if (!key) return null;
  if (keymap.controlPlayForward.keys.includes(key)) return "forward";
  if (keymap.controlPlayReverse.keys.includes(key)) return "reverse";
  if (keymap.controlStop.keys.includes(key)) return "stop";
  return null;
}

/**
 * Feeds key presses and releases to whichever transport the keys drive, and wakes itself to turn
 * a held J or L into half speed. Only keys that are physically down count as held: the same
 * action from a menu just shuttles or stops. `reset` lets go of everything, as when the window
 * loses focus.
 */
export function createJog(player: () => Transport) {
  let jog = idleJog;
  let driving: Transport | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const down = new Set<JogKey>();

  function apply([next, effect]: [Jog, JogEffect]) {
    jog = next;
    const target = driving ?? player();
    if (!effect) return;
    if (effect.type === "step") target.step(effect.frames);
    else target.dispatch(effect);
  }

  return {
    /** A key went down, before any shortcut handles it. */
    keyDown(key: JogKey) {
      down.add(key);
    },
    /** The action for J, L or K ran. */
    press(key: JogKey) {
      if (!down.has(key)) {
        const [, effect] = jogPress(idleJog, key);
        if (effect) apply([jog, effect]);
        return;
      }
      if (!jog.stop && !jog.held) driving = player();
      apply(jogPress(jog, key));
      clearTimeout(timer);
      if (jog.stop && jog.held && !jog.slow)
        timer = setTimeout(() => apply(jogHold(jog)), HOLD_MS);
    },
    release(key: JogKey) {
      down.delete(key);
      apply(jogRelease(jog, key));
      if (!jog.stop && !jog.held) driving = null;
    },
    reset() {
      clearTimeout(timer);
      down.clear();
      if (jog.held) apply(jogRelease(jog, jog.held));
      if (jog.stop) apply(jogRelease(jog, "stop"));
      driving = null;
    },
  };
}
