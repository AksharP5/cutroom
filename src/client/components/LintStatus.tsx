import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { compactLint } from "../../shared/lint";
import type { LintFinding } from "../../shared/lint";
import { subscribeProjectEvents } from "../api";
import { showToast } from "../workspace";
import { menuStep } from "./menu";
import "./select-menu.css";

type Lint = ReturnType<typeof compactLint>;

const fileChangeSchema = z.object({ affectsPreview: z.boolean() });
/** Saves arrive in bursts; one lint after the last is enough. */
const SETTLE_MS = 400;

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

const location = (finding: LintFinding) =>
  finding.file && `${finding.file}${finding.line ? `:${finding.line}` : ""}`;

/**
 * Selects the finding's clip and moves the playhead to it when Cutroom's timeline shows it;
 * otherwise copies where it is, for an agent or another editor.
 */
async function reveal(finding: LintFinding) {
  if (finding.elementId) {
    const [{ useTimeline }, { transport }] = await Promise.all([
      import("../edit/timeline"),
      import("../edit/transport"),
    ]);
    const clip = useTimeline
      .getState()
      .view?.timeline.clips.find((item) => item.id === finding.elementId);
    if (clip) {
      useTimeline.setState({
        selection: { ids: new Set([clip.id]), anchor: clip.id },
      });
      transport.seek(clip.start);
      return;
    }
  }
  const where = location(finding) ?? finding.elementId;
  if (!where) return;
  await navigator.clipboard.writeText(where);
  showToast(`Copied ${where}`, null, { tone: "info", transient: true });
}

/** HyperFrames lint findings for the project, rechecked whenever a source file changes. */
export function LintStatus({ projectId }: { projectId: string }) {
  const [lint, setLint] = useState<Lint | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", at: 0 });
  const anchor = `--lint-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;

  useEffect(() => {
    setLint(null);
    setFailure(null);
    let request = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      request.abort();
      request = new AbortController();
      const { signal } = request;
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/lint`,
          { signal },
        );
        const body: unknown = await response.json();
        if (!response.ok)
          throw new Error(
            z.object({ error: z.string() }).safeParse(body).data?.error ??
              `Lint returned ${response.status}`,
          );
        setLint(compactLint(body));
        setFailure(null);
      } catch (error) {
        if (signal.aborted) return;
        setFailure(error instanceof Error ? error.message : String(error));
      }
    };
    void check();
    const unsubscribe = subscribeProjectEvents(
      projectId,
      "file-change",
      (event) => {
        const change = fileChangeSchema.safeParse(JSON.parse(event.data));
        if (!change.success || !change.data.affectsPreview) return;
        clearTimeout(timer);
        timer = setTimeout(() => void check(), SETTLE_MS);
      },
    );
    return () => {
      unsubscribe();
      clearTimeout(timer);
      request.abort();
    };
  }, [projectId]);

  if (failure)
    return (
      <span className="status-error" title={failure}>
        Lint failed
      </span>
    );
  // Info findings alone are advice, not problems; they are listed after any that are.
  if (!lint || (!lint.errors && !lint.warnings)) return null;
  const { errors, warnings, findings } = lint;
  const summary = [
    errors && plural(errors, "error"),
    warnings && plural(warnings, "warning"),
  ]
    .filter(Boolean)
    .join(", ");
  const rows = () => [
    ...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ];
  return (
    <>
      <button
        className="status-lint"
        data-errors={errors || undefined}
        style={{ anchorName: anchor }}
        popoverTarget={`${anchor}-menu`}
        title="HyperFrames lint findings"
      >
        {summary}
      </button>
      <div
        ref={menu}
        id={`${anchor}-menu`}
        className="select-menu lint-menu"
        style={{ positionAnchor: anchor }}
        role="menu"
        aria-label="Lint findings"
        popover="auto"
        onToggle={(event) => {
          if (event.newState === "open") rows()[0]?.focus();
        }}
        onKeyDown={(event) => {
          const items = rows();
          const next = menuStep(
            event,
            findings.map((finding) => finding.message),
            items.findIndex((row) => row === document.activeElement),
            search.current,
          );
          if (next === null) return;
          event.preventDefault();
          items[next]?.focus();
        }}
      >
        {findings.map((finding, index) => (
          <button
            type="button"
            role="menuitem"
            key={index}
            tabIndex={-1}
            data-severity={finding.severity}
            title={finding.fixHint}
            onClick={() => {
              menu.current?.hidePopover();
              void reveal(finding).catch((error: unknown) =>
                showToast(
                  error instanceof Error ? error.message : String(error),
                ),
              );
            }}
          >
            <span>{finding.message}</span>
            <small className="mono">
              {[finding.elementId && `#${finding.elementId}`, location(finding)]
                .filter(Boolean)
                .join(" ")}
            </small>
          </button>
        ))}
      </div>
    </>
  );
}
