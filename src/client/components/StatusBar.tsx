import type { Project } from "../../shared/project";
import type { ReviewItem } from "../../shared/review";
import { useWorkspace } from "../workspace";

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
  const accepted = items.filter((item) => item.review.status === "accepted");
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
      <span className="status-space" />
      {composition && (
        <span className="mono">{Number(composition.fps.toFixed(3))} fps</span>
      )}
      {composition?.width && composition.height && (
        <span className="mono">
          {composition.width} x {composition.height}
        </span>
      )}
      {items.length > 0 && (
        <button onClick={onReview} title="Accepted notes of all notes">
          Queue {accepted.length}/{items.length}
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
