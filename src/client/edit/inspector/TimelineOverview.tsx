import type { Timeline, TimelineView } from "../../../shared/timeline/schema";
import { formatTimecode } from "../../../shared/timeline/timecode";
import { useWorkspace } from "../../workspace";
import { showSource } from "../source";
import { transport } from "../transport";
import { ChangeList } from "./ChangeList";
import { ledgerChanges } from "./changes";

/** With nothing selected, the inspector describes the timeline: its format, markers and history. */
export function TimelineOverview({
  projectId,
  name,
  timeline,
  edits,
}: {
  projectId: string;
  name: string;
  timeline: Timeline;
  edits: NonNullable<TimelineView["clipEdits"]>;
}) {
  const composition = useWorkspace((state) => state.composition);
  const { fps, duration, range, markers } = timeline;
  const time = (frame: number) => formatTimecode(frame, fps);
  const seek = (frame: number) => {
    showSource(false);
    transport.seek(frame);
  };
  return (
    <div className="inspector-content">
      <div className="inspector-timeline">
        <strong title={name}>{name}</strong>
      </div>
      <section className="inspector-section">
        <h3>Format</h3>
        <dl className="inspector-facts">
          {composition?.width && composition.height && (
            <>
              <dt>Picture</dt>
              <dd>
                {composition.width} × {composition.height}
              </dd>
            </>
          )}
          <dt>Rate</dt>
          <dd>{Number((fps.num / fps.den).toFixed(3))} fps</dd>
          <dt>Length</dt>
          <dd>{time(duration)}</dd>
          {(range.in !== null || range.out !== null) && (
            <>
              <dt>In to out</dt>
              <dd>
                {time(range.in ?? 0)} <span>to</span>{" "}
                {time((range.out ?? duration) - 1)}
              </dd>
            </>
          )}
        </dl>
      </section>
      {markers.length > 0 && (
        <section className="inspector-section">
          <h3>
            Markers <span className="inspector-count">{markers.length}</span>
          </h3>
          <ol className="inspector-markers">
            {markers
              .toSorted((a, b) => a.frame - b.frame)
              .map((marker) => (
                <li key={marker.id}>
                  <button
                    type="button"
                    data-color={marker.color}
                    title={marker.note || undefined}
                    onClick={() => seek(marker.frame)}
                  >
                    <span>{marker.name || "Marker"}</span>
                    <time>{time(marker.frame)}</time>
                  </button>
                </li>
              ))}
          </ol>
        </section>
      )}
      <ChangeList
        projectId={projectId}
        timeline={timeline}
        edits={ledgerChanges(edits)}
        limit={8}
      />
    </div>
  );
}
