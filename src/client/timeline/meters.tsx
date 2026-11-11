import { useEffect, useRef } from "react";
import { audioLevels } from "../edit/levels";

const FLOOR_DB = -60;
const height = (level: number) =>
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
  const current = height(value);
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

/** One bounded paint per runtime sample. No clock, React updates, or animation while idle. */
export function AudioMeters({
  source = audioLevels,
  compact = false,
  label = "Stereo output levels, dBFS",
}: {
  source?: Pick<typeof audioLevels, "subscribe">;
  compact?: boolean;
  label?: string;
} = {}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const channels = [
      ...(root.current?.querySelectorAll<HTMLElement>(".tl-meter-channel") ??
        []),
    ].map((channel) => ({
      channel,
      level: channel.querySelector<HTMLElement>(".tl-meter-level")!,
      peak: channel.querySelector<HTMLElement>(".tl-meter-peak")!,
      clip: channel.querySelector<HTMLButtonElement>(".tl-meter-clip")!,
      state: emptyMeter,
    }));
    for (const item of channels)
      item.clip.onclick = () => {
        item.state = { ...item.state, clipped: false };
        item.channel.dataset.clipping = "false";
        item.clip.disabled = true;
      };
    const unsubscribe = source.subscribe((level) => {
      if (compact)
        root.current?.setAttribute(
          "aria-valuenow",
          String(Math.round(Math.min(1, level.l) * 100)),
        );
      const now = performance.now();
      channels.forEach((item, index) => {
        const { channel, level: bar, peak, clip } = item;
        const value = index === 0 ? level.l : level.r;
        const current = height(value);
        item.state = meterSample(item.state, value, level.playing, now);
        // Clipping the lit segments keeps each LED its size; the peak line moves on the compositor.
        bar.style.clipPath = compact
          ? `inset(0 ${(1 - current) * 100}% 0 0)`
          : `inset(${(1 - current) * 100}% 0 0 0)`;
        peak.style.transform = compact
          ? `translateX(calc(${item.state.peak * 100}% - var(--stroke-hair)))`
          : `translateY(${(1 - item.state.peak) * 100}%)`;
        peak.hidden = item.state.peak === 0;
        channel.dataset.clipping = String(item.state.clipped);
        clip.disabled = !item.state.clipped;
      });
    });
    return () => {
      unsubscribe();
      for (const item of channels) item.clip.onclick = null;
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
