import type { Project } from "../../shared/project";
import type { ReviewItem } from "../../shared/review";
import { useWorkspace } from "../workspace";
import { toReviewStatuses } from "../review";

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
  const waiting = items.filter((item) =>
    toReviewStatuses.includes(item.review.status),
  );
  const folder = project.path.split(/[\\/]/).filter(Boolean).at(-1);
  return (
    <footer className="status-bar">
      <button
        className="status-folder"
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
      <span className="status-space" />
      {composition && (
        <span className="mono">{Number(composition.fps.toFixed(3))} fps</span>
      )}
      {composition?.width && composition.height && (
        <span className="mono">
          {composition.width} x {composition.height}
        </span>
      )}
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
