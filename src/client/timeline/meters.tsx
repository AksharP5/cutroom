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

/** One bounded paint per runtime sample. No clock, React updates, or animation while idle. */
export function AudioMeters() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const channels =
      root.current?.querySelectorAll<HTMLElement>(".tl-meter-channel");
    const peaks = [0, 0];
    const held = [0, 0];
    let previous = performance.now();
    return audioLevels.subscribe((level) => {
      const now = performance.now();
      const elapsed = Math.min(100, now - previous);
      previous = now;
      channels?.forEach((channel, index) => {
        const value = index === 0 ? level.l : level.r;
        const current = height(value);
        if (current >= peaks[index]!) {
          peaks[index] = current;
          held[index] = now + 1500;
        } else if (now > held[index]!)
          peaks[index] = Math.max(current, peaks[index]! - elapsed / 2500);
        channel.querySelector<HTMLElement>(".tl-meter-level")!.style.transform =
          `scaleY(${current})`;
        channel.querySelector<HTMLElement>(".tl-meter-peak")!.style.bottom =
          `${peaks[index]! * 100}%`;
        channel.dataset.clipping = String(value >= 1);
      });
    });
  }, []);
  return (
    <div
      ref={root}
      className="tl-meters"
      role="img"
      aria-label="Stereo output levels, dBFS"
    >
      <div className="tl-meter-scale">
        {[0, 6, 12, 24, 48].map((db) => (
          <span key={db} style={{ top: `${(db / 60) * 100}%` }}>
            {db}
          </span>
        ))}
      </div>
      {(["L", "R"] as const).map((name) => (
        <div key={name} className="tl-meter-channel">
          <span>{name}</span>
          <div className="tl-meter-level" />
          <i className="tl-meter-peak" />
        </div>
      ))}
    </div>
  );
}
