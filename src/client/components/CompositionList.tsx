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
const fileChangeSchema = z.object({ path: z.string() });

interface Composition {
  path: string;
  seconds: number | null;
}

/**
 * The project's compositions, root first, with their lengths, read again whenever an HTML file
 * changes. Null until the first listing.
 */
export function useCompositions(projectId: string) {
  const [compositions, setCompositions] = useState<Composition[] | null>(null);
  /** Bumped by each HTML change, so thumbnails are drawn again. */
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setCompositions(null);
    let request = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      request.abort();
      request = new AbortController();
      const { signal } = request;
      const project = `/api/projects/${encodeURIComponent(projectId)}`;
      const { compositions: paths } = ListingSchema.parse(
        await (await fetch(project, { signal })).json(),
      );
      const listed = await Promise.all(
        paths
          .toSorted((a, b) =>
            a === ROOT_COMPOSITION
              ? -1
              : b === ROOT_COMPOSITION
                ? 1
                : a.localeCompare(b),
          )
          .map(async (path) => {
            // A composition the engine cannot read is still listed, without a length.
            const view = await api(
              `/projects/${encodeURIComponent(projectId)}/timeline?composition=${encodeURIComponent(path)}`,
              TimelineViewSchema,
              { signal },
            ).catch(() => null);
            return {
              path,
              seconds:
                view && frameTime(view.timeline.duration, view.timeline.fps),
            };
          }),
      );
      if (!signal.aborted) setCompositions(listed);
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
        const change = fileChangeSchema.safeParse(JSON.parse(event.data));
        if (!change.success || !/\.html?$/i.test(change.data.path)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          setRevision((value) => value + 1);
          reload();
        }, 150);
      },
    );
    return () => {
      unsubscribe();
      clearTimeout(timer);
      request.abort();
    };
  }, [projectId]);
  return { compositions, revision };
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
  compositions,
  revision,
}: {
  projectId: string;
  compositions: readonly Composition[];
  revision: number;
}) {
  const fps = useFps();
  const open = useTimeline((state) => state.composition);
  const { lint } = useLint(projectId);
  const [focused, setFocused] = useState<string>();
  const list = useRef<HTMLUListElement>(null);
  const tabbable = compositions.some((item) => item.path === focused)
    ? focused
    : compositions[0]?.path;
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
      {compositions.map(({ path, seconds }) => {
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
                  src={`/api/projects/${encodeURIComponent(projectId)}/thumbnail/${encodeURIComponent(path)}?${new URLSearchParams({ t: (seconds / 3).toFixed(3), v: String(revision) })}`}
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
