import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { z } from "zod";
import {
  COMPONENT_SECONDS,
  LIBRARY_CATEGORIES,
  libraryTitle,
  librarySearch,
} from "../../shared/library";
import type { LibraryCategory, LibraryItem } from "../../shared/library";
import { frameTimecode, subscribeProjectEvents } from "../api";
import {
  librarySource,
  loadLibrary,
  loadUsedLibrary,
  placeLibraryAtPlayhead,
  useLibrary,
} from "../edit/library";
import { openSource as showSource, useSource } from "../edit/source";
import { useTimeline } from "../edit/timeline";
import { gridStep } from "../home";
import { focusByKeyboard, reachedByKeyboard } from "../keymap";
import { MEDIA_DRAG_TYPE, setMediaDrag } from "../timeline/mediaDrag";
import { useFps } from "../workspace";
import { openContextMenu } from "./ContextMenu";
import { SelectMenu } from "./SelectMenu";
import { TimecodeText } from "./TimecodeText";

type Filter = "all" | LibraryCategory | "project";
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  ...LIBRARY_CATEGORIES.map(({ id, label }) => ({ value: id, label })),
  { value: "project", label: "In this project" },
];

const savedOn = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Why an offline list cannot add an item it has not downloaded yet. */
export const offlineReason = (savedAt: string) =>
  `Showing the list saved on ${savedOn(savedAt)}. Items you haven't opened yet can't be added.`;

export function focusLibraryRow(element: HTMLElement | null | undefined) {
  focusByKeyboard(element);
  element?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * One observer for the whole list tells each row when it first comes into view, so opening 448
 * rows sets up one observer instead of one per row.
 */
function posterObserver(list: RefObject<HTMLUListElement | null>) {
  const waiting = new Map<Element, () => void>();
  let observer: IntersectionObserver | null = null;
  return {
    observe(element: Element, seen: () => void) {
      observer ??= new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            waiting.get(entry.target)?.();
            waiting.delete(entry.target);
            observer?.unobserve(entry.target);
          }
        },
        { root: list.current },
      );
      waiting.set(element, seen);
      observer.observe(element);
      return () => {
        waiting.delete(element);
        observer?.unobserve(element);
      };
    },
    dispose() {
      observer?.disconnect();
      waiting.clear();
    },
  };
}
type Posters = ReturnType<typeof posterObserver>;

/** One item: its poster once the row has been on screen, its title, and a block's length. */
const LibraryRow = memo(function LibraryRow({
  item,
  disabled,
  used,
  adding,
  tabbable,
  posters,
  onFocus,
}: {
  item: LibraryItem;
  disabled: string | undefined;
  used: boolean;
  adding: boolean;
  tabbable: boolean;
  posters: Posters;
  onFocus(name: string): void;
}) {
  const fps = useFps();
  const size = useTimeline((state) => state.view?.size);
  const row = useRef<HTMLLIElement>(null);
  // Posters load only for rows that have been in the list's view.
  const [seen, setSeen] = useState(false);
  // A poster the registry no longer serves leaves the thumb empty, as an item without one.
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const element = row.current;
    if (!element || seen || !item.hasPoster) return;
    return posters.observe(element, () => setSeen(true));
  }, [seen, item.hasPoster, posters]);
  const title = libraryTitle(item.title);
  const otherSize =
    item.dimensions &&
    size &&
    (item.dimensions.width !== size.width ||
      item.dimensions.height !== size.height)
      ? `${title} · ${item.dimensions.width} x ${item.dimensions.height}`
      : title;
  const placeable = !disabled && !adding;
  const open = useSource((state) => state.file?.library?.name === item.name);
  // The source viewer needs a timeline: its playhead counts the timeline's frames.
  const openSource = () => {
    if (disabled || !useTimeline.getState().view) return;
    showSource(librarySource(item));
    // The transport keys go to the source now, not to moving through the list.
    row.current?.blur();
  };
  return (
    <li
      ref={row}
      className="media-row"
      aria-label={title}
      aria-disabled={disabled ? true : undefined}
      title={disabled ?? otherSize}
      data-kind="composition"
      data-name={item.name}
      data-used={used || undefined}
      aria-current={open || undefined}
      tabIndex={tabbable ? 0 : -1}
      draggable={placeable}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocus(item.name);
      }}
      onDragStart={(event) => {
        if (!placeable) return event.preventDefault();
        event.dataTransfer.setData(MEDIA_DRAG_TYPE, item.name);
        event.dataTransfer.effectAllowed = "copy";
        setMediaDrag({
          kind: "composition",
          path: `compositions/${item.name}.html`,
          seconds: item.duration ?? COMPONENT_SECONDS,
          hasAudio: false,
          library: item,
        });
      }}
      onDragEnd={() => setMediaDrag(null)}
      onClick={openSource}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget)
          openSource();
      }}
      onContextMenu={(event) => {
        const unplaceable = !placeable || !useTimeline.getState().view;
        openContextMenu(
          event,
          title,
          [
            {
              label: "Open in source viewer",
              disabled: !!disabled || !useTimeline.getState().view,
              run: openSource,
            },
            "separator",
            {
              label: "Insert at playhead",
              disabled: unplaceable,
              run: () => void placeLibraryAtPlayhead(item, "insert"),
            },
            {
              label: "Overwrite at playhead",
              disabled: unplaceable,
              run: () => void placeLibraryAtPlayhead(item, "overwrite"),
            },
            "separator",
            {
              label: "Copy name",
              run: () => void navigator.clipboard.writeText(item.name),
            },
          ],
          event.currentTarget,
        );
      }}
    >
      <span className="media-thumb library-thumb" aria-hidden="true">
        {seen && !broken && (
          <img
            onError={() => setBroken(true)}
            src={`/api/cutroom/library/posters/${encodeURIComponent(item.name)}`}
            alt=""
            draggable={false}
          />
        )}
      </span>
      <span className="media-name">{title}</span>
      {adding ? (
        <span className="library-status">Adding</span>
      ) : (
        item.duration !== undefined && (
          <span className="media-duration mono">
            <TimecodeText timecode={frameTimecode(item.duration, fps)} />
          </span>
        )
      )}
    </li>
  );
});

/**
 * The HyperFrames library beside Media. It reads nothing until it is first shown, and while
 * hidden it runs no timers and makes no requests.
 */
export function LibraryList({
  projectId,
  hidden,
  search,
  focusRequest,
}: {
  projectId: string;
  hidden: boolean;
  search: RefObject<HTMLInputElement | null>;
  /** Changes each time the panel key asks for the list. */
  focusRequest: number;
}) {
  const status = useLibrary((state) => state.status);
  const catalog = useLibrary((state) => state.catalog);
  const adding = useLibrary((state) => state.adding);
  const used = useLibrary((state) =>
    state.used.projectId === projectId ? state.used.names : null,
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [focused, setFocused] = useState<string>();
  const list = useRef<HTMLUListElement>(null);
  const posters = useMemo(() => posterObserver(list), []);
  useEffect(() => () => posters.dispose(), [posters]);

  useEffect(() => {
    if (hidden) return;
    loadLibrary();
    loadUsedLibrary(projectId);
    // Undo, redo and agents change which items the project has; cutroom.json records them.
    return subscribeProjectEvents(projectId, "message", (event) => {
      const changed = z
        .object({ changed: z.string() })
        .safeParse(JSON.parse(event.data)).data?.changed;
      if (changed === "cutroom.json") loadUsedLibrary(projectId);
    });
  }, [hidden, projectId]);

  const visible = useMemo(() => {
    if (!catalog) return [];
    const needle = query.trim();
    const matches = librarySearch(needle);
    return catalog.items.flatMap((item) => {
      // Too new or deprecated items show only to a search for their exact name.
      if (item.hidden && needle !== item.name) return [];
      if (
        filter === "project"
          ? !used?.has(item.name)
          : filter !== "all" && item.category !== filter
      )
        return [];
      return matches(item) ? [item] : [];
    });
  }, [catalog, query, filter, used]);

  // The panel key lands on the list's current row, or the search, once they are drawn.
  const focusHandled = useRef(0);
  useEffect(() => {
    if (hidden || !catalog || focusRequest === focusHandled.current) return;
    focusHandled.current = focusRequest;
    focusLibraryRow(
      list.current?.querySelector<HTMLElement>('.media-row[tabindex="0"]') ??
        search.current,
    );
  }, [hidden, catalog, focusRequest, search]);

  const offline = catalog?.offline ? offlineReason(catalog.savedAt) : null;
  const tabbable = visible.some((item) => item.name === focused)
    ? focused
    : visible[0]?.name;

  if (status === "unreachable")
    return (
      <div className="library-message" hidden={hidden}>
        <span>Can't reach the HyperFrames library.</span>
        <button className="text-button" onClick={() => loadLibrary(true)}>
          Try again
        </button>
      </div>
    );
  if (!catalog)
    return (
      <div className="library-message" role="status" hidden={hidden}>
        Loading library
      </div>
    );
  return (
    <div className="library-body" hidden={hidden}>
      <div className="library-filter">
        <div className="media-search">
          <MagnifyingGlass aria-hidden />
          <input
            ref={search}
            type="search"
            aria-label="Search library"
            placeholder="Search library"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
              if (event.key === "ArrowDown") {
                const first =
                  list.current?.querySelector<HTMLElement>(".media-row");
                if (!first) return;
                event.preventDefault();
                focusLibraryRow(first);
              }
            }}
          />
        </div>
        <SelectMenu<Filter>
          label="Category"
          value={filter}
          options={FILTERS}
          onChange={setFilter}
        />
      </div>
      {visible.length === 0 ? (
        <div className="media-empty" role="status">
          No matches
        </div>
      ) : (
        <ul
          className="media-list"
          aria-label="Library"
          ref={list}
          onKeyDown={(event) => {
            if (
              !(event.target instanceof HTMLElement) ||
              !event.target.matches(".media-row") ||
              !reachedByKeyboard(event.target) ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey
            )
              return;
            const rows = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                ".media-row",
              ),
            ];
            const next = gridStep(
              event.key,
              rows.indexOf(event.target),
              1,
              rows.length,
            );
            if (next === null) return;
            event.preventDefault();
            focusLibraryRow(rows[next]);
          }}
        >
          {visible.map((item) => (
            <LibraryRow
              key={item.name}
              item={item}
              disabled={
                item.disabled ?? (offline && !item.cached ? offline : undefined)
              }
              used={used?.has(item.name) ?? false}
              adding={adding.has(item.name)}
              tabbable={item.name === tabbable}
              posters={posters}
              onFocus={setFocused}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
