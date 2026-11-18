import type { Project } from "../../shared/project";
import type { ReviewItem } from "../../shared/review";
import { useOfflineMedia } from "../edit/offlineMedia";
import { showSource } from "../edit/source";
import { useTimeline } from "../edit/timeline";
import { transport } from "../edit/transport";
import { useWorkspace } from "../workspace";
import { toReviewStatuses } from "../review";
import { LintStatus } from "./LintStatus";

/** Only what the app knows: values it cannot read yet are left out, never guessed. */
export function StatusBar({
  project,
  items,
  onReview,
}: {
  project: Project;
  items: ReviewItem[];
  onReview: () => void;
}) {
  const composition = useWorkspace((state) => state.composition);
  const exporting = useWorkspace((state) => state.exporting);
  const agent = useWorkspace((state) => state.agent);
  const { timeline, viewer } = useWorkspace((state) => state.editorErrors);
  const editorError = timeline ?? viewer;
  const offline = useOfflineMedia(project.id);
  const selectOffline = () => {
    let first;
    for (const clip of offline.values())
      if (!first || clip.start < first.start) first = clip;
    if (!first) return;
    showSource(false);
    useTimeline.setState({
      selection: { ids: new Set([first.id]), anchor: first.id },
    });
    transport.seek(first.start);
  };
  const waiting = items.filter((item) =>
    toReviewStatuses.includes(item.review.status),
  );
  const folder = project.path.split(/[\\/]/).filter(Boolean).at(-1);
  return (
    <footer className="status-bar">
      <button
        className="status-folder"
        aria-label="Copy project folder path"
        title={`Copy ${project.path}`}
        onClick={() => void navigator.clipboard.writeText(project.path)}
      >
        {folder}
      </button>
      {editorError && (
        <span className="status-error" role="alert" title={editorError}>
          {editorError}
        </span>
      )}
      {offline.size > 0 && (
        <button
          type="button"
          className="status-offline"
          title="Go to the first offline clip"
          onClick={selectOffline}
        >
          {offline.size} {offline.size === 1 ? "file" : "files"} offline
        </button>
      )}
      <span className="status-space" />
      {composition && (
        <span className="mono">{Number(composition.fps.toFixed(3))} fps</span>
      )}
      {composition?.width && composition.height && (
        <span className="mono">
          {composition.width} x {composition.height}
        </span>
      )}
      <LintStatus projectId={project.id} />
      {waiting.length > 0 && (
        <button
          onClick={onReview}
          title="Completed notes and agent questions waiting for you"
        >
          To review {waiting.length}
        </button>
      )}
      {exporting && <span>Exporting</span>}
      {agent && (
        <span
          className="status-agent"
          data-connected={agent.available || undefined}
        >
          {agent.name} {agent.available ? "connected" : "unavailable"}
        </span>
      )}
      <span className="mono">MCP {window.location.host}/mcp</span>
    </footer>
  );
}
