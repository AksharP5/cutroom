import { isTitle } from "../../../shared/timeline/title";
import type { Clip, Fps } from "../../../shared/timeline/schema";
import { formatTimecode } from "../../../shared/timeline/timecode";
import { TimecodeText } from "../../components/TimecodeText";

export function SelectionSummary({ clips, fps }: { clips: Clip[]; fps: Fps }) {
  if (!clips.length) return null;
  const kinds = new Map<string, number>();
  let start = Infinity;
  let end = 0;
  let length = 0;
  for (const clip of clips) {
    const kind = isTitle(clip)
      ? "title"
      : clip.kind === "element"
        ? "text"
        : clip.kind;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    start = Math.min(start, clip.start);
    end = Math.max(end, clip.start + clip.duration);
    length += clip.duration;
  }
  const time = (frame: number) => (
    <time>
      <TimecodeText timecode={formatTimecode(frame, fps)} />
    </time>
  );
  return (
    <section className="inspector-section">
      <dl className="inspector-facts">
        <dt>Types</dt>
        <dd className="inspector-selection-types">
          {[...kinds].map(([kind, count]) => `${count} ${kind}`).join(", ")}
        </dd>
        <dt>Span</dt>
        <dd>
          {time(start)} <span className="inspector-range-join">to</span>{" "}
          {time(end - 1)}
        </dd>
        <dt>Total length</dt>
        <dd>{time(length)}</dd>
      </dl>
    </section>
  );
}
