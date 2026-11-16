import { CaretRight } from "@phosphor-icons/react";
import { Fragment } from "react";
import { leaveComposition } from "./compositions";
import { ROOT_COMPOSITION, useTimeline } from "./timeline";

/** `compositions/intro.html` reads as `intro`; the root reads as the project. */
const compositionName = (path: string, projectName: string) =>
  path === ROOT_COMPOSITION
    ? projectName
    : (path.split("/").at(-1) ?? path).replace(/\.html?$/i, "");

/**
 * Where the timeline is, shown only inside a sub-composition: the project, the compositions it
 * was opened through, and the open one. A name above the open one goes back to it.
 */
export function CompositionPath({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const composition = useTimeline((state) => state.composition);
  const parents = useTimeline((state) => state.parents);
  if (!parents.length) return null;
  return (
    <nav className="edit-path" aria-label="Composition">
      {parents.map((path, index) => (
        <Fragment key={path}>
          <button
            className="edit-path-step"
            title={
              index === parents.length - 1
                ? `Back to ${path} (Esc)`
                : `Back to ${path}`
            }
            onClick={() => leaveComposition(projectId, path)}
          >
            {compositionName(path, projectName)}
          </button>
          <CaretRight className="edit-path-caret" size={10} aria-hidden />
        </Fragment>
      ))}
      <span className="edit-path-open" aria-current="page" title={composition}>
        {compositionName(composition, projectName)}
      </span>
    </nav>
  );
}
