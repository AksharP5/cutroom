import type { EditorContext, SelectedClip } from "../../shared/editor";
import { clipEnd, frameTime } from "../../shared/timeline/apply";
import { clipName } from "../../shared/timeline/labels";
import type { Clip, TimelineView } from "../../shared/timeline/schema";
import { frameCaptureUrl } from "../review";
import { pictureBox } from "./preview";
import { useTimeline } from "./timeline";
import { useTransport } from "./transport";

const selectedClips = (view: TimelineView) => {
  const { ids } = useTimeline.getState().selection;
  return view.timeline.clips.filter((clip) => ids.has(clip.id));
};

const describe = (clip: Clip, view: TimelineView): SelectedClip => ({
  id: clip.id,
  name: clipName(clip),
  kind: clip.kind,
  start: frameTime(clip.start, view.timeline.fps),
  end: frameTime(clipEnd(clip), view.timeline.fps),
});

/** What the agent is told about the editor with each message: the open composition and the clips selected in it. */
export function editorContext(): EditorContext {
  const { frame, fps, duration, state } = useTransport.getState();
  const { view } = useTimeline.getState();
  const clips = view
    ? selectedClips(view).map((clip) => describe(clip, view))
    : [];
  return {
    currentTime: frameTime(frame, fps),
    duration: frameTime(duration, fps),
    isPlaying: state.kind !== "stopped",
    compositionPath: view?.composition ?? "index.html",
    selectedElementIds: clips.map((clip) => clip.id),
    selectedClips: clips,
  };
}

const tagNames: Record<Clip["kind"], string> = {
  video: "video",
  audio: "audio",
  voiceover: "audio",
  image: "img",
  composition: "div",
  element: "div",
};

/**
 * HyperFrames' selection snapshot for the first selected clip, the shape `hyperframes preview
 * --context` reads from `/api/projects/:id/selection`. Only the clip's own project data goes in.
 */
function selectionSnapshot(projectId: string) {
  const { view } = useTimeline.getState();
  const clip = view && selectedClips(view)[0];
  if (!view || !clip) return null;
  const { frame, fps } = useTransport.getState();
  const currentTime = frameTime(frame, fps);
  const shown = pictureBox.current();
  const box = shown?.clipId === clip.id ? shown.box : null;
  return {
    schemaVersion: 1,
    projectId,
    compositionPath: view.composition,
    sourceFile: view.composition,
    label: clipName(clip),
    tagName: tagNames[clip.kind],
    thumbnailUrl: frameCaptureUrl(projectId, {
      time: currentTime,
      compositionPath: view.composition,
    }),
    currentTime,
    target: { id: clip.id, selector: `#${CSS.escape(clip.id)}` },
    boundingBox: box ?? { x: 0, y: 0, width: 0, height: 0 },
    textContent: clip.text,
    dataAttributes: {},
    inlineStyles: {},
    computedStyles: {},
    textFields: [],
    capabilities: {},
  };
}

/**
 * Keeps HyperFrames' selection route in step with the timeline selection, so an agent can read
 * what the person selected mid-turn. Returns the unsubscribe.
 */
export function publishSelection(projectId: string) {
  const url = `/api/projects/${encodeURIComponent(projectId)}/selection`;
  let last: string | undefined;
  let request = new AbortController();
  // Each message carries the selection already; this copy is best effort, so a failed or
  // superseded write is dropped.
  const put = (selection: ReturnType<typeof selectionSnapshot>) =>
    fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection }),
      signal: request.signal,
      keepalive: selection === null,
    }).catch(() => {});
  const publish = () => {
    const { view, selection, projectId: shown } = useTimeline.getState();
    if (shown !== projectId) return;
    // The viewer reports a clip's box just after it is selected; publish again once it has.
    const shownBox = pictureBox.current();
    const boxed =
      shownBox?.box != null &&
      view != null &&
      selectedClips(view)[0]?.id === shownBox.clipId;
    const key = `${view?.composition}\n${boxed}\n${[...selection.ids].join("\n")}`;
    if (key === last) return;
    last = key;
    request.abort();
    request = new AbortController();
    void put(selectionSnapshot(projectId));
  };
  publish();
  const timelineChanged = useTimeline.subscribe(publish);
  const boxChanged = pictureBox.subscribe(publish);
  return () => {
    timelineChanged();
    boxChanged();
    request.abort();
    request = new AbortController();
    void put(null);
  };
}
