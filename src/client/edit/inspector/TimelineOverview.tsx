import type { TimelineView } from "../../../shared/timeline/schema";
import { formatTimecode } from "../../../shared/timeline/timecode";
import { TimecodeText } from "../../components/TimecodeText";
import { useState } from "react";
import { defaultFormat, rateLabel } from "../../../shared/projectFormat";
import { FormatDialog } from "./FormatDialog";
import { showSource } from "../source";
import { ROOT_COMPOSITION } from "../timeline";
import { transport } from "../transport";
import { ChangeList } from "./ChangeList";
import type { InspectorChange } from "../../../shared/timeline/reviewChanges";
import { VariablesSection } from "./VariablesSection";

/** With nothing selected, the inspector describes the timeline: its format, markers and history. */
export function TimelineOverview({
  projectId,
  name,
  view,
  edits,
  hold,
}: {
  projectId: string;
  name: string;
  view: TimelineView;
  edits: InspectorChange[];
  /** Passed to the Changes list: see `ChangeList`. */
  hold: boolean;
}) {
  const { timeline } = view;
  const { width, height } = view.size ?? defaultFormat;
  const [editing, setEditing] = useState<TimelineView | null>(null);
  const { fps, duration, range, markers } = timeline;
  const time = (frame: number) => (
    <TimecodeText timecode={formatTimecode(frame, fps)} />
  );
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
        <h3>
          Format
          {view.composition === ROOT_COMPOSITION && (
            <button
              className="inspector-format-edit"
              type="button"
              aria-label="Edit project format"
              onClick={() => setEditing(view)}
            >
              Edit
            </button>
          )}
        </h3>
        <dl className="inspector-facts">
          <dt>Picture</dt>
          <dd>
            {width} × {height}
          </dd>
          <dt>Rate</dt>
          <dd>{rateLabel(fps)} fps</dd>
          <dt>Length</dt>
          <dd>{time(duration)}</dd>
          {(range.in !== null || range.out !== null) && (
            <>
              <dt>In to out</dt>
              <dd>
                {time(range.in ?? 0)}{" "}
                <span className="inspector-range-join">to</span>{" "}
                {time((range.out ?? duration) - 1)}
              </dd>
            </>
          )}
        </dl>
      </section>
      {editing && (
        <FormatDialog
          projectId={projectId}
          view={editing}
          size={editing.size ?? defaultFormat}
          onClose={() => setEditing(null)}
        />
      )}
      <VariablesSection projectId={projectId} />
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
        edits={edits}
        limit={8}
        hold={hold}
      />
    </div>
  );
}
