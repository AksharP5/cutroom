import { useEffect, useRef } from "react";
import { Faders } from "@phosphor-icons/react";
import { audioLevels } from "../edit/levels";

const FLOOR_DB = -60;
/** A peak's height on the meter: 0 dBFS at the top, -60 dBFS and below empty. */
export const meterHeight = (level: number) =>
  Math.max(
    0,
    Math.min(
      1,
      (20 * Math.log10(Math.max(1e-3, level)) - FLOOR_DB) / -FLOOR_DB,
    ),
  );

export const emptyMeter = {
  peak: 0,
  held: 0,
  at: 0,
  playing: false,
  clipped: false,
};

/** Playback owns peak hold; clipping survives a stop until cleared or playback restarts. */
export function meterSample(
  state: typeof emptyMeter,
  value: number,
  playing: boolean,
  now: number,
) {
  const current = meterHeight(value);
  const elapsed = Math.min(100, now - state.at);
  const fall = now > state.held ? elapsed / 2500 : 0;
  return {
    peak: playing ? Math.max(current, state.peak - fall) : 0,
    held: playing && current >= state.peak ? now + 1500 : state.held,
    at: now,
    playing,
    clipped: (playing && !state.playing ? false : state.clipped) || value >= 1,
  };
}

/** One meter channel: where its clip state shows, its lit level, its peak line and clip mark. */
export interface MeterChannel {
  element: HTMLElement;
  lit: HTMLElement;
  peak: HTMLElement;
  clip: HTMLButtonElement;
}

/**
 * Paints meter channels from runtime samples, for the meter column, the microphone meter and
 * every mixer strip. Peaks hold and fall during playback; a clip mark latches until it is
 * clicked or playback restarts. `slide` moves the lit segments by whole 3 px LEDs inside a
 * clipping bar and the peak by pixels, all transforms, which a bank of strips needs; `clip`
 * clips the lit segments in place. Nothing changes between samples, and unchanged bars are not
 * written.
 */
export function meterPainter(
  channels: readonly MeterChannel[],
  { axis = "vertical", draw = "clip" } = {} as {
    axis?: "vertical" | "horizontal";
    draw?: "clip" | "slide";
  },
) {
  const items = channels.map((parts) => ({
    ...parts,
    state: emptyMeter,
    shown: -1,
    clipped: false,
  }));
  let length = 0;
  const measure = () => {
    const bar = items[0]?.lit.parentElement;
    length = bar
      ? axis === "vertical"
        ? bar.clientHeight
        : bar.clientWidth
      : 0;
    for (const item of items) item.shown = -1;
  };
  measure();
  const showClip = (item: (typeof items)[number]) => {
    if (item.clipped === item.state.clipped) return;
    item.clipped = item.state.clipped;
    item.element.dataset.clipping = String(item.clipped);
    item.clip.disabled = !item.clipped;
  };
  for (const item of items)
    item.clip.onclick = () => {
      item.state = { ...item.state, clipped: false };
      showClip(item);
    };
  return {
    measure,
    paint(values: readonly number[], playing: boolean, now: number) {
      items.forEach((item, index) => {
        const value = values[index] ?? 0;
        item.state = meterSample(item.state, value, playing, now);
        const height = meterHeight(value);
        if (draw === "slide") {
          const segments = Math.ceil(length / 3);
          const lit = Math.round(height * segments);
          if (lit !== item.shown) {
            item.shown = lit;
            item.lit.style.transform = `translateY(${(segments - lit) * 3}px)`;
          }
        } else if (height !== item.shown) {
          item.shown = height;
          item.lit.style.clipPath =
            axis === "horizontal"
              ? `inset(0 ${(1 - height) * 100}% 0 0)`
              : `inset(${(1 - height) * 100}% 0 0 0)`;
        }
        const { peak } = item.state;
        if (item.peak.hidden !== (peak === 0)) item.peak.hidden = peak === 0;
        if (peak)
          item.peak.style.transform =
            axis === "horizontal"
              ? `translateX(calc(${peak * 100}% - var(--stroke-hair)))`
              : draw === "slide"
                ? `translateY(${Math.round((1 - peak) * length)}px)`
                : `translateY(${(1 - peak) * 100}%)`;
        showClip(item);
      });
    },
    dispose() {
      for (const item of items) item.clip.onclick = null;
    },
  };
}

/** One bounded paint per runtime sample. No clock, React updates, or animation while idle. */
export function AudioMeters({
  source = audioLevels,
  compact = false,
  label = "Stereo output levels, dBFS",
  onMixer,
}: {
  source?: Pick<typeof audioLevels, "subscribe">;
  compact?: boolean;
  label?: string;
  /** Opens the mixer from the column's head. */
  onMixer?(): void;
} = {}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const painter = meterPainter(
      [
        ...(root.current?.querySelectorAll<HTMLElement>(".tl-meter-channel") ??
          []),
      ].map((element) => ({
        element,
        lit: element.querySelector<HTMLElement>(".tl-meter-level")!,
        peak: element.querySelector<HTMLElement>(".tl-meter-peak")!,
        clip: element.querySelector<HTMLButtonElement>(".tl-meter-clip")!,
      })),
      { axis: compact ? "horizontal" : "vertical" },
    );
    const unsubscribe = source.subscribe((level) => {
      if (compact)
        root.current?.setAttribute(
          "aria-valuenow",
          String(Math.round(Math.min(1, level.l) * 100)),
        );
      painter.paint([level.l, level.r], level.playing, performance.now());
    });
    return () => {
      unsubscribe();
      painter.dispose();
    };
  }, [source, compact]);
  return (
    <div
      ref={root}
      className={`tl-meters${compact ? " tl-meters-compact" : ""}`}
      role={compact ? "meter" : "group"}
      aria-label={label}
      aria-valuemin={compact ? 0 : undefined}
      aria-valuemax={compact ? 100 : undefined}
      aria-valuenow={compact ? 0 : undefined}
    >
      {onMixer && (
        <button
          type="button"
          className="icon-button mixer-toggle"
          aria-label="Mixer"
          aria-pressed="false"
          title="Mixer"
          onClick={onMixer}
        >
          <Faders size={16} />
        </button>
      )}
      {!compact && (
        <div className="tl-meter-scale">
          {[0, -6, -12, -24, -48].map((db) => (
            <span key={db} style={{ top: `${(-db / 60) * 100}%` }}>
              {db}
            </span>
          ))}
        </div>
      )}
      {(compact ? ["I"] : ["L", "R"]).map((name) => (
        <div key={name} className="tl-meter-channel">
          <span>{name}</span>
          <button
            className="tl-meter-clip"
            aria-label={
              compact
                ? "Clear microphone clipping indicator"
                : `Clear ${name} clipping indicator`
            }
            title={
              compact
                ? "Clear microphone clipping indicator"
                : `Clear ${name} clipping indicator`
            }
            disabled
          />
          <div className="tl-meter-level" />
          <i className="tl-meter-peak" hidden />
        </div>
      ))}
    </div>
  );
}
