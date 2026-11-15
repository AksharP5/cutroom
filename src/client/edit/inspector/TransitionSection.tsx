import { clipEnd, cutRoom } from "../../../shared/timeline/apply";
import {
  TRANSITION_ALIGNMENTS,
  TRANSITION_KINDS,
} from "../../../shared/timeline/schema";
import type { Timeline, Transition } from "../../../shared/timeline/schema";
import { formatTimecode } from "../../../shared/timeline/timecode";
import { TRANSITION_NAMES } from "../../../shared/timeline/transition";
import { SelectMenu } from "../../components/SelectMenu";
import { trackRows } from "../../timeline/math";
import { editTimeline } from "../timeline";
import { ValueField } from "./ValueField";

const ALIGNMENT_LABELS: Record<Transition["alignment"], string> = {
  center: "Centre on cut",
  start: "Start on cut",
  end: "End on cut",
};

/** The selected transition: its kind, length and where it sits on the cut, each one undo step. */
export function TransitionSection({
  projectId,
  timeline,
  incoming,
}: {
  projectId: string;
  timeline: Timeline;
  /** The clip the transition leads into. */
  incoming: string;
}) {
  const to = timeline.clips.find((clip) => clip.id === incoming);
  const from =
    to &&
    timeline.clips.find(
      (clip) =>
        clip.track === to.track &&
        clipEnd(clip) === to.start &&
        clip.transitionOut,
    );
  const transition = to?.transitionIn;
  if (!to || !from || !transition)
    return <p className="inspector-empty">Select a clip to inspect it.</p>;
  const track = trackRows(timeline.tracks, {
    video: 0,
    audio: 0,
    seam: 0,
    divider: 0,
  }).rows.find((row) => row.track.index === to.track);
  const edit = (change: Partial<Transition>) =>
    void editTimeline(projectId, "Edit transition", () => [
      {
        type: "setTransition",
        from: from.id,
        to: to.id,
        transition: { ...transition, ...change },
      },
    ]);
  return (
    <div className="inspector-content">
      <div className="inspector-clip" data-kind={to.kind}>
        <strong>{TRANSITION_NAMES[transition.kind]}</strong>
        <span>
          Transition on {track?.id} ·{" "}
          <time>{formatTimecode(to.start, timeline.fps)}</time>
        </span>
      </div>
      <section className="inspector-section inspector-transition">
        <div className="inspector-field">
          <span className="inspector-label">Kind</span>
          <div className="inspector-value">
            <SelectMenu
              label="Kind"
              value={transition.kind}
              options={TRANSITION_KINDS.map((kind) => ({
                value: kind,
                label: TRANSITION_NAMES[kind],
              }))}
              onChange={(kind) => edit({ kind })}
            />
          </div>
        </div>
        <ValueField
          key={`${to.id}:${transition.alignment}`}
          label="Length"
          value={transition.duration}
          unit="timecode"
          min={1}
          max={cutRoom(timeline, from, to, transition.alignment).frames}
          fps={timeline.fps}
          onCommit={(duration) => {
            if (duration !== null) edit({ duration });
          }}
        />
        <div className="inspector-field">
          <span className="inspector-label">Alignment</span>
          <div className="inspector-value">
            <SelectMenu
              label="Alignment"
              value={transition.alignment}
              options={TRANSITION_ALIGNMENTS.map((alignment) => ({
                value: alignment,
                label: ALIGNMENT_LABELS[alignment],
              }))}
              onChange={(alignment) => edit({ alignment })}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
