import { useEffect, useRef, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { z } from "zod";
import { frameTime } from "../../shared/timeline/apply";
import { TimelineViewSchema } from "../../shared/timeline/schema";
import { api, frameTimecode, subscribeProjectEvents } from "../api";
import { openComposition } from "../edit/compositions";
import { placeAtPlayhead } from "../edit/placeMedia";
import { ROOT_COMPOSITION, useTimeline } from "../edit/timeline";
import { useLint } from "../lint";
import { MEDIA_DRAG_TYPE, setMediaDrag } from "../timeline/mediaDrag";
import type { MediaDrag } from "../timeline/mediaDrag";
import { useFps } from "../workspace";
import { openContextMenu } from "./ContextMenu";
import { TimecodeText } from "./TimecodeText";

const ListingSchema = z.object({ compositions: z.array(z.string()) });
const FileChangeSchema = z.object({
  path: z.string(),
  version: z.string().nullable(),
  affectedCompositions: z.array(z.string()).nullable(),
});
/** Saves arrive in bursts; one read after the last is enough. */
const SETTLE_MS = 150;

const isHtml = (path: string) => /\.html?$/i.test(path);
const rootFirst = (a: string, b: string) =>
  a === ROOT_COMPOSITION ? -1 : b === ROOT_COMPOSITION ? 1 : a.localeCompare(b);

/**
 * The project's composition files, root first. Read again only when an HTML file appears or is
 * removed, since an edit to one never changes the list. Null until the first listing.
 */
export function useCompositions(projectId: string) {
  const [paths, setPaths] = useState<string[] | null>(null);
  useEffect(() => {
    setPaths(null);
    let known: string[] = [];
    let request = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      request.abort();
      request = new AbortController();
      const { signal } = request;
      const { compositions } = ListingSchema.parse(
        await (
          await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
            signal,
          })
        ).json(),
      );
      if (signal.aborted) return;
      known = compositions.toSorted(rootFirst);
      setPaths(known);
    };
    const reload = () =>
      void load().catch((error: unknown) => {
        if (!request.signal.aborted) console.warn("Compositions", error);
      });
    reload();
    const unsubscribe = subscribeProjectEvents(
      projectId,
      "file-change",
      (event) => {
        const change = FileChangeSchema.safeParse(JSON.parse(event.data));
        if (
          !change.success ||
          !isHtml(change.data.path) ||
          (change.data.version !== null && known.includes(change.data.path))
        )
          return;
        clearTimeout(timer);
        timer = setTimeout(reload, SETTLE_MS);
      },
    );
    return () => {
      unsubscribe();
      clearTimeout(timer);
      request.abort();
    };
  }, [projectId]);
  return paths;
}

/**
 * Each listed composition's length in seconds and a version for its picture. Read when the list
 * opens, then again only for compositions a source change affects, and for the one just left.
 * The open composition's length is the editor's own timeline, so editing it reads nothing more.
 */
function useLengths(projectId: string, paths: readonly string[]) {
  const [read, setRead] = useState<
    ReadonlyMap<string, { seconds: number | null; version: number }>
  >(new Map());
  const openPath = useTimeline((state) => state.view?.composition);
  const openSeconds = useTimeline((state) =>
    state.view
      ? frameTime(state.view.timeline.duration, state.view.timeline.fps)
      : null,
  );
  const listed = paths.join("\n");
  /** Reads lengths and redraws pictures for the given compositions. */
  const remeasure = useRef<(targets: readonly string[]) => void>(() => {});
  // Leaving a composition: what was edited there while it was open is read now.
  const left = useRef(openPath);
  useEffect(() => {
    const previous = left.current;
    left.current = openPath;
    if (previous && previous !== openPath) remeasure.current([previous]);
  }, [openPath]);
  useEffect(() => {
    const closing = new AbortController();
    const stale = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = (targets: readonly string[]) =>
      Promise.all(
        targets.map(async (path) => {
          // A composition the engine cannot read is still listed, without a length.
          const view = await api(
            `/projects/${encodeURIComponent(projectId)}/timeline?composition=${encodeURIComponent(path)}`,
            TimelineViewSchema,
            { signal: closing.signal },
          ).catch(() => null);
          return [
            path,
            view && frameTime(view.timeline.duration, view.timeline.fps),
          ] as const;
        }),
      ).then((lengths) => {
        if (closing.signal.aborted) return;
        setRead((current) => {
          const next = new Map(current);
          for (const [path, seconds] of lengths)
            next.set(path, {
              seconds,
              version: (current.get(path)?.version ?? 0) + 1,
            });
          return next;
        });
      });
    remeasure.current = (targets) => void measure(targets);
    const all = listed ? listed.split("\n") : [];
    void measure(all);
    const unsubscribe = subscribeProjectEvents(
      projectId,
      "file-change",
      (event) => {
        const change = FileChangeSchema.safeParse(JSON.parse(event.data));
        if (!change.success || !isHtml(change.data.path)) return;
        for (const path of change.data.affectedCompositions ?? all)
          if (all.includes(path)) stale.add(path);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const targets = [...stale];
          stale.clear();
          // The open composition is read when it is left.
          const shown = useTimeline.getState().composition;
          void measure(targets.filter((path) => path !== shown));
        }, SETTLE_MS);
      },
    );
    return () => {
      closing.abort();
      unsubscribe();
      clearTimeout(timer);
    };
  }, [projectId, listed]);
  return (path: string) => {
    const known = read.get(path);
    return {
      seconds: openPath === path ? openSeconds : (known?.seconds ?? null),
      version: known?.version ?? 0,
    };
  };
}

const compositionName = (path: string) =>
  (path.split("/").at(-1) ?? path).replace(/\.html?$/i, "");

/**
 * Every composition with a picture, its length and its lint. Double-click or Enter opens one in
 * the editor; dragging one onto the timeline, or Insert or Overwrite at playhead, places it as a
 * scene.
 */
export function CompositionList({
  projectId,
  paths,
}: {
  projectId: string;
  paths: readonly string[];
}) {
  const length = useLengths(projectId, paths);
  const fps = useFps();
  const open = useTimeline((state) => state.composition);
  const { lint } = useLint(projectId);
  const [focused, setFocused] = useState<string>();
  const list = useRef<HTMLUListElement>(null);
  const tabbable = paths.includes(focused ?? "") ? focused : paths[0];
  return (
    <ul
      className="media-list"
      ref={list}
      aria-label="Compositions"
      onKeyDown={(event) => {
        if (
          !(event.target instanceof HTMLElement) ||
          !event.target.matches(".media-row")
        )
          return;
        const rows = [
          ...(list.current?.querySelectorAll<HTMLElement>(".media-row") ?? []),
        ];
        const at = rows.indexOf(event.target);
        const next =
          event.key === "ArrowDown"
            ? rows[at + 1]
            : event.key === "ArrowUp"
              ? rows[at - 1]
              : undefined;
        if (!next) return;
        event.preventDefault();
        next.focus();
      }}
    >
      {paths.map((path) => {
        const { seconds, version } = length(path);
        const findings =
          lint?.findings.filter(
            (finding) => finding.file === path && finding.severity !== "info",
          ) ?? [];
        const errors = findings.some((finding) => finding.severity === "error");
        // A composition cannot play itself, and the root plays every scene.
        const placeable =
          seconds !== null && path !== ROOT_COMPOSITION && path !== open;
        const dragged = (): MediaDrag => ({
          kind: "composition",
          path,
          seconds: seconds ?? 0,
          hasAudio: false,
        });
        const place = (mode: "insert" | "overwrite") =>
          void placeAtPlayhead(projectId, dragged(), mode);
        return (
          <li
            key={path}
            className="media-row"
            title={path}
            data-kind="composition"
            data-path={path}
            aria-current={path === open || undefined}
            tabIndex={path === tabbable ? 0 : -1}
            onFocus={(event) => {
              if (event.target === event.currentTarget) setFocused(path);
            }}
            draggable={placeable}
            onDragStart={(event) => {
              event.dataTransfer.setData(MEDIA_DRAG_TYPE, path);
              event.dataTransfer.effectAllowed = "copy";
              setMediaDrag(dragged());
            }}
            onDragEnd={() => setMediaDrag(null)}
            onDoubleClick={() => openComposition(projectId, path)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.target === event.currentTarget)
                openComposition(projectId, path);
            }}
            onContextMenu={(event) =>
              openContextMenu(
                event,
                path,
                [
                  {
                    label: "Open",
                    disabled: path === open,
                    run: () => openComposition(projectId, path),
                  },
                  "separator",
                  {
                    label: "Insert at playhead",
                    disabled: !placeable,
                    run: () => place("insert"),
                  },
                  {
                    label: "Overwrite at playhead",
                    disabled: !placeable,
                    run: () => place("overwrite"),
                  },
                ],
                event.currentTarget,
              )
            }
          >
            <span className="media-thumb" aria-hidden="true">
              {seconds !== null && (
                <img
                  src={`/api/projects/${encodeURIComponent(projectId)}/thumbnail/${encodeURIComponent(path)}?${new URLSearchParams({ t: (seconds / 3).toFixed(3), v: String(version) })}`}
                  alt=""
                  loading="lazy"
                />
              )}
            </span>
            <span className="media-name">
              {path === ROOT_COMPOSITION ? path : compositionName(path)}
            </span>
            {findings.length > 0 && (
              <span
                className="composition-lint"
                data-errors={errors || undefined}
                title={findings.map((finding) => finding.message).join("\n")}
                aria-label={`${findings.length} lint findings`}
              >
                <WarningCircle size={12} weight="bold" />
                {findings.length}
              </span>
            )}
            <span className="media-duration mono">
              {seconds !== null && (
                <TimecodeText timecode={frameTimecode(seconds, fps)} />
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
