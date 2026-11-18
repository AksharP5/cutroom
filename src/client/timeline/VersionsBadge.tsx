import { useEffect, useLayoutEffect, useRef } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { Clip } from "../../shared/timeline/schema";
import { activeVersion } from "../../shared/timeline/versions";
import { menuStep } from "../components/menu";
import type { MenuSearch } from "../components/menu";
import { restoreMenuFocus } from "../keymap";
import { editTimeline, useTimeline } from "../edit/timeline";
import {
  closeVersions,
  hoverVersion,
  openVersions,
  useVersions,
} from "../edit/versions";
import "./versions.css";

const run = (label: string, command: Parameters<typeof editTimeline>[2]) => {
  const { projectId } = useTimeline.getState();
  if (projectId) void editTimeline(projectId, label, command);
};

/** The count on a clip with versions, which opens the list of them. */
export function VersionsBadge({ clip }: { clip: Clip & { versions: object } }) {
  const open = useVersions((state) => state.open === clip.id);
  const anchor = `--versions-${clip.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const count = clip.versions.length;
  // A press outside an open list closes it before the click, so the press decides.
  const wasOpen = useRef(false);
  return (
    <>
      <button
        type="button"
        className="tl-versions"
        style={{ anchorName: anchor }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${count} versions`}
        onPointerDown={(event) => {
          // The lanes would select or move the clip underneath.
          event.stopPropagation();
          wasOpen.current = useVersions.getState().open === clip.id;
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          // A keyboard click has no press before it.
          const close = event.detail ? wasOpen.current : open;
          wasOpen.current = false;
          if (close) closeVersions();
          else openVersions(clip.id);
        }}
      >
        {count}
        <CaretDown size={8} weight="bold" />
      </button>
      {open && <VersionsMenu clip={clip} anchor={anchor} />}
    </>
  );
}

function VersionsMenu({
  clip,
  anchor,
}: {
  clip: Clip & { versions: { name: string; src: string }[] };
  anchor: string;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<MenuSearch>({ text: "", at: 0 });
  const returnFocus = useRef<Element | null>(null);
  const hovered = useVersions((state) => state.hovered);
  const active = activeVersion(clip);
  const { versions } = clip;
  useLayoutEffect(() => {
    returnFocus.current = document.activeElement;
    menu.current?.showPopover();
    menu.current?.focus({ preventScroll: true });
  }, []);
  // The list goes with its clip: a keep, an undo or a zoom that hides the label closes it.
  useEffect(
    () => () => {
      if (useVersions.getState().open === clip.id) closeVersions();
    },
    [clip.id],
  );
  const items = () =>
    menu.current?.querySelectorAll<HTMLButtonElement>("[data-version]") ?? [];
  const show = (index: number) => {
    if (index === active) return;
    run(`Show version "${versions[index]!.name}"`, () => [
      { type: "setVersion", clipId: clip.id, version: index },
    ]);
  };
  return (
    <div
      ref={menu}
      className="versions-menu"
      style={{ positionAnchor: anchor }}
      role="menu"
      aria-label={`Versions of ${clip.label ?? clip.id}`}
      tabIndex={-1}
      popover="auto"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerLeave={() => hoverVersion(clip, null)}
      onToggle={(event) => {
        if (event.newState === "open") return;
        closeVersions();
        if (
          document.activeElement === document.body ||
          menu.current?.contains(document.activeElement)
        )
          restoreMenuFocus(
            returnFocus.current instanceof HTMLElement
              ? returnFocus.current
              : null,
          );
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          menu.current?.hidePopover();
          return;
        }
        const buttons = [...items()];
        const next = menuStep(
          event,
          versions.map(({ name }) => name),
          buttons.findIndex((button) => button === document.activeElement),
          search.current,
        );
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        buttons[next]?.focus({ preventScroll: true });
      }}
    >
      <div className="versions-count">{versions.length} versions</div>
      {versions.map((version, index) => (
        <button
          type="button"
          key={version.src}
          role="menuitemradio"
          aria-checked={index === active}
          data-version={index}
          data-hovered={index === hovered || undefined}
          tabIndex={-1}
          onPointerEnter={() => hoverVersion(clip, index)}
          onFocus={() => hoverVersion(clip, index)}
          onClick={() => show(index)}
        >
          <span>{version.name}</span>
          {index === active && <Check size={12} weight="bold" />}
        </button>
      ))}
      <hr />
      <button
        type="button"
        className="versions-keep"
        tabIndex={-1}
        onPointerEnter={() => hoverVersion(clip, null)}
        onClick={() => {
          run(`Keep version "${versions[active]!.name}"`, () => [
            { type: "keepVersion", clipId: clip.id },
          ]);
          menu.current?.hidePopover();
        }}
      >
        Keep {versions[active]!.name}
      </button>
    </div>
  );
}
