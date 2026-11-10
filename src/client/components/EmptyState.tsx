import { FolderOpen, Plus } from "@phosphor-icons/react";
import { Logo } from "./Logo";

export function EmptyState({
  onCreate,
  onImport,
}: {
  onCreate: () => void;
  onImport: () => void;
}) {
  return (
    <section className="welcome">
      <Logo />
      <h1>Make the next cut.</h1>
      <p>Your footage, your agents, your workspace.</p>
      <div className="welcome-actions">
        <button className="primary-button" onClick={onCreate}>
          <Plus />
          New project
        </button>
        <button className="secondary-button" onClick={onImport}>
          <FolderOpen />
          Open folder
        </button>
      </div>
      <div className="welcome-instructions">
        <div>
          <kbd>D</kbd>
          <span>Draw a change on the picture</span>
        </div>
        <div>
          <kbd>C</kbd>
          <span>Leave a note at any moment</span>
        </div>
        <div>
          <kbd>$</kbd>
          <span>Bring your skills into the conversation</span>
        </div>
      </div>
    </section>
  );
}
