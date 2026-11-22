import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import { clipName } from "../../shared/timeline/labels";
import { localMediaPath } from "../../shared/media";
import { VersionNameSchema } from "../../shared/timeline/schema";
import type { Clip, Fps } from "../../shared/timeline/schema";
import {
  activeVersion,
  canAddVersion,
  mediaVersions,
  sourceRate,
  versionPartners,
  versionShortReason,
} from "../../shared/timeline/versions";
import { TimecodeText } from "../components/TimecodeText";
import { formatTimecode } from "../../shared/timeline/timecode";
import { menuStep } from "../components/menu";
import type { MenuSearch } from "../components/menu";
import { hint, restoreMenuFocus } from "../keymap";
import { editTimeline, useTimeline } from "../edit/timeline";
import {
  addClipVersion,
  closeVersions,
  hoverVersion,
  openVersions,
  primeVersions,
  useVersions,
} from "../edit/versions";
import "./versions.css";

const run = (label: string, command: Parameters<typeof editTimeline>[2]) => {
  const { projectId } = useTimeline.getState();
  if (projectId) void editTimeline(projectId, label, command);
};

type VersionedClip = Clip & Required<Pick<Clip, "versions">>;

/** The count on a clip with versions, which opens the list of them. */
export function VersionsBadge({
  clip,
  fps,
  locked,
}: {
  clip: VersionedClip;
  fps: Fps;
  locked: boolean;
}) {
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
        data-media={mediaVersions(clip.kind) || undefined}
        style={{ anchorName: anchor }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${count} versions`}
        title={`${hint("cutroomPreviousVersion")} · ${hint("cutroomNextVersion")}`}
        onPointerDown={(event) => {
          // The lanes would select or move the clip underneath.
          event.stopPropagation();
          wasOpen.current = useVersions.getState().open === clip.id;
        }}
        onPointerEnter={() => primeVersions(clip.id)}
        onPointerLeave={() => primeVersions(null)}
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
      {open && (
        <VersionsMenu clip={clip} anchor={anchor} fps={fps} locked={locked} />
      )}
    </>
  );
}

function VersionsMenu({
  clip,
  anchor,
  fps,
  locked,
}: {
  clip: VersionedClip;
  anchor: string;
  fps: Fps;
  locked: boolean;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<MenuSearch>({ text: "", at: 0 });
  const returnFocus = useRef<Element | null>(null);
  const hovered = useVersions((state) => state.hovered);
  const active = activeVersion(clip);
  const { versions } = clip;
  const media = mediaVersions(clip.kind);
  const name = clipName(clip);
  const [renaming, setRenaming] = useState<number | null>(null);
  const view = useTimeline((state) => state.view);
  const partners = view ? versionPartners(view.timeline.clips, clip) : [];
  const readOnly =
    locked ||
    partners.some(({ track }) =>
      view?.timeline.tracks.some((row) => row.index === track && row.locked),
    );
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
    menu.current?.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ) ?? [];
  const show = (index: number) => {
    if (index === active || readOnly) return;
    run(
      media
        ? `Showed ${versions[index]!.name} on ${name}`
        : `Show version "${versions[index]!.name}"`,
      () => [{ type: "setVersion", clipId: clip.id, version: index }],
    );
  };
  return (
    <div
      ref={menu}
      className={`versions-menu${media ? " with-source" : ""}`}
      style={{ positionAnchor: anchor }}
      role="menu"
      aria-label={`Versions of ${media ? name : (clip.label ?? clip.id)}`}
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
        if (renaming !== null) return;
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          menu.current?.hidePopover();
          return;
        }
        const buttons = [...items()];
        const next = menuStep(
          event,
          buttons.map((button) => button.textContent ?? ""),
          buttons.findIndex((button) => button === document.activeElement),
          search.current,
        );
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        buttons[next]?.focus({ preventScroll: true });
      }}
    >
      {versions.map((version, index) => {
        const invalid = version.offline || version.fits === false;
        const matched = index === active;
        const check = matched && <Check size={12} weight="bold" />;
        const select = () => {
          if (!invalid) hoverVersion(clip, index);
          else hoverVersion(clip, null);
        };
        const source =
          (localMediaPath("index.html", version.src) ?? version.src)
            .split("/")
            .at(-1) ?? version.src;
        const offset = Math.round(version.sourceIn ?? 0);
        const limit = offset ? 10 : invalid ? 16 : 22;
        const filename =
          source.length > limit
            ? `${source.slice(0, limit - 8)}…${source.slice(-7)}`
            : source;
        const note = version.offline ? (
          "Offline"
        ) : version.fits === false ? (
          "Too short"
        ) : offset ? (
          <TimecodeText
            timecode={formatTimecode(offset, {
              num: Math.round(sourceRate(version, fps)),
              den: 1,
            })}
          />
        ) : null;
        const origin = (
          <span className="versions-source">
            <span>{filename}</span>
            {note && <b data-offline={version.offline}>{note}</b>}
          </span>
        );
        const finishRename = (value?: string) => {
          setRenaming(null);
          menu.current?.focus({ preventScroll: true });
          const next = VersionNameSchema.safeParse(value);
          if (next.success && next.data !== version.name) {
            run(`Renamed ${version.name} on ${name}`, () => [
              {
                type: "renameVersion",
                clipId: clip.id,
                version: index,
                name: next.data,
              },
            ]);
          }
        };
        if (renaming === index)
          return (
            <div key={index} className="versions-rename">
              <span>{check}</span>
              <input
                aria-label="Version name"
                defaultValue={version.name}
                maxLength={60}
                ref={(element) => {
                  element?.focus({ preventScroll: true });
                  element?.select();
                }}
                onBlur={() => finishRename()}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  finishRename(
                    event.key === "Enter"
                      ? event.currentTarget.value
                      : undefined,
                  );
                }}
              />
              {origin}
            </div>
          );
        return (
          <button
            type="button"
            key={index}
            role="menuitemradio"
            aria-checked={matched}
            aria-disabled={readOnly || invalid || undefined}
            disabled={invalid || undefined}
            title={
              version.fits === false && !version.offline
                ? versionShortReason(version, fps)
                : media
                  ? source
                  : undefined
            }
            data-version={index}
            data-hovered={index === hovered || undefined}
            tabIndex={-1}
            onPointerEnter={select}
            onFocus={select}
            onClick={() => show(index)}
          >
            {media && <span>{check}</span>}
            <span
              onDoubleClick={(event) => {
                event.stopPropagation();
                if (!media || readOnly) return;
                hoverVersion(clip, null);
                setRenaming(index);
              }}
            >
              {version.name}
            </span>
            {media ? origin : check}
          </button>
        );
      })}
      <hr />
      {media && (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={!view || !canAddVersion(clip, view.timeline)}
          onPointerEnter={() => hoverVersion(clip, null)}
          onFocus={() => hoverVersion(clip, null)}
          onClick={() => addClipVersion(clip)}
        >
          <span></span>
          <span>Add version</span>
        </button>
      )}
      <button
        type="button"
        className="versions-keep"
        disabled={readOnly}
        role="menuitem"
        tabIndex={-1}
        onPointerEnter={() => hoverVersion(clip, null)}
        onFocus={() => hoverVersion(clip, null)}
        onClick={() => {
          run(
            media
              ? `Kept ${versions[active]!.name} on ${name}`
              : `Keep version "${versions[active]!.name}"`,
            () => [{ type: "keepVersion", clipId: clip.id }],
          );
          menu.current?.hidePopover();
        }}
      >
        {media ? (
          <>
            <span></span>
            <span>Keep {versions[active]!.name}</span>
          </>
        ) : (
          <>Keep {versions[active]!.name}</>
        )}
      </button>
    </div>
  );
}
