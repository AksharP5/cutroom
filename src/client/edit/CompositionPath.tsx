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
 * Where the timeline is: inside a scene, the timeline and compositions it was opened through and
 * the open one, where a name above the open one goes back to it. Another timeline than the main
 * one shows its name alone, since it was opened as an equal.
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
  if (!parents.length && composition === ROOT_COMPOSITION) return null;
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
