import { useEffect, useLayoutEffect, useRef } from "react";
import { Check } from "@phosphor-icons/react";
import { create } from "zustand";
import { menuFocusTarget, restoreMenuFocus, runAction } from "../keymap";
import { showToast } from "../workspace";
import { itemText, menuStep } from "./menu";
import type { MenuItem } from "./menu";
import "./select-menu.css";

/** Space kept between the menu and the window's edge. */
const MARGIN = 8;

interface OpenMenu {
  id: number;
  label: string;
  items: readonly MenuItem[];
  /** Opened by the menu key or Shift+F10: the first row takes focus. */
  keyboard: boolean;
  x: number;
  y: number;
  /** Where the menu's bottom edge goes when it does not fit below `y`. */
  above: number;
  /** What had focus, which gets it back when the menu closes by key or by choosing a row. */
  restore: HTMLElement | null;
}

const useContextMenu = create(() => ({ menu: null as OpenMenu | null }));

/**
 * Opens a menu for a `contextmenu` event: at the pointer for a right-click, or hanging from
 * `anchor` for the menu key and Shift+F10, which the browser reports with no button.
 */
export function openContextMenu(
  event: {
    preventDefault(): void;
    button: number;
    clientX: number;
    clientY: number;
  },
  label: string,
  items: readonly MenuItem[],
  anchor: Pick<Element, "getBoundingClientRect">,
) {
  event.preventDefault();
  const keyboard = event.button < 0;
  const box = anchor.getBoundingClientRect();
  const focused = document.activeElement;
  useContextMenu.setState(({ menu }) => ({
    menu: {
      id: (menu?.id ?? 0) + 1,
      label,
      items,
      keyboard,
      ...(keyboard
        ? { x: box.left, y: box.bottom + 2, above: box.top - 2 }
        : { x: event.clientX, y: event.clientY, above: event.clientY }),
      restore: menuFocusTarget(focused, !keyboard),
    },
  }));
}

/** The desktop's row for showing a file or folder in the file manager; a browser has none. */
export function revealRows(path: string): MenuItem[] {
  const desktop = window.cutroomDesktop;
  return desktop
    ? [
        {
          label: "Reveal in folder",
          run: () =>
            void desktop
              .reveal(path)
              .catch((error: unknown) =>
                showToast(
                  error instanceof Error ? error.message : String(error),
                ),
              ),
        },
      ]
    : [];
}

function close(restore: boolean) {
  const { menu } = useContextMenu.getState();
  if (!menu) return;
  useContextMenu.setState({ menu: null });
  if (restore) restoreMenuFocus(menu.restore);
}

function Menu({ menu }: { menu: OpenMenu }) {
  const root = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", at: 0 });
  const rows = () => [
    ...(root.current?.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    ) ?? []),
  ];
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    element.showPopover();
    const { offsetWidth: width, offsetHeight: height } = element;
    element.style.left = `${Math.max(MARGIN, Math.min(menu.x, innerWidth - width - MARGIN))}px`;
    element.style.top = `${
      menu.y + height + MARGIN <= innerHeight
        ? menu.y
        : Math.max(MARGIN, menu.above - height)
    }px`;
    ((menu.keyboard && rows()[0]) || element).focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    const outside = (event: Event) => {
      if (!(
        event.target instanceof Node && root.current?.contains(event.target)
      ))
        close(true);
    };
    const leave = () => close(false);
    // A right press opens its menu before the release, so the popover's own light dismiss
    // would close it again on that release. The menu closes itself instead.
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("wheel", outside, true);
    window.addEventListener("blur", leave);
    window.addEventListener("resize", leave);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("wheel", outside, true);
      window.removeEventListener("blur", leave);
      window.removeEventListener("resize", leave);
    };
  }, []);
  const checks = menu.items.some(
    (item) => item !== "separator" && item.checked !== undefined,
  );
  return (
    <div
      ref={root}
      className="select-menu context-menu"
      role="menu"
      aria-label={menu.label}
      popover="manual"
      tabIndex={-1}
      data-checks={checks || undefined}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        // The menu takes every key while it is open; none reaches the editor's shortcuts.
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          close(true);
          return;
        }
        const items = rows();
        const next = menuStep(
          event,
          items.map((item) => item.dataset.label ?? ""),
          items.findIndex((item) => item === document.activeElement),
          search.current,
        );
        if (next === null) return;
        event.preventDefault();
        items[next]?.focus({ preventScroll: true });
        items[next]?.scrollIntoView({ block: "nearest" });
      }}
    >
      {menu.items.map((item, index) => {
        if (item === "separator") return <hr key={index} />;
        const { label, keys } = itemText(item);
        return (
          <button
            key={index}
            type="button"
            role={
              item.checked === undefined
                ? "menuitem"
                : item.radio
                  ? "menuitemradio"
                  : "menuitemcheckbox"
            }
            aria-checked={item.checked}
            aria-keyshortcuts={keys?.replace("Ctrl", "Control")}
            data-label={label}
            disabled={item.disabled}
            tabIndex={-1}
            // The row under the pointer is the focused row, so there is one highlight, not two.
            onPointerMove={(event) =>
              event.currentTarget.focus({ preventScroll: true })
            }
            onClick={() => {
              close(true);
              if ("action" in item) runAction(item.action);
              else item.run();
            }}
          >
            {checks && (
              <span className="context-menu-check" aria-hidden="true">
                {item.checked && <Check size={12} weight="bold" />}
              </span>
            )}
            <span>{label}</span>
            {keys && <kbd aria-hidden="true">{keys}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

/** The one context menu, mounted once by the shell and opened with `openContextMenu`. */
export function ContextMenuHost() {
  const menu = useContextMenu((state) => state.menu);
  return menu && <Menu key={menu.id} menu={menu} />;
}
