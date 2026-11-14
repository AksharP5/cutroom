import { useEffect, useId, useRef, useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { menuStep } from "./menu";
import { menuFocusTarget, restoreMenuFocus } from "../keymap";
import "./select-menu.css";

/** The viewer's popover picker, shared by fields and compact toolbar controls. */
export function SelectMenu<const Value extends string>({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  title,
}: {
  id?: string;
  label: string;
  value: Value;
  options: readonly { value: Value; label: string }[];
  onChange(value: Value): void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const uid = useId();
  const menuId = `${uid}-list`;
  const anchor = `--select-${uid.replace(/[^a-zA-Z0-9-]/g, "")}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const search = useRef({ text: "", at: 0 });
  const returnFocus = useRef(false);
  const restore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (disabled) {
      menu.current?.hidePopover();
      return;
    }
    // Selecting a conversation or model briefly disables its trigger while it loads.
    if (returnFocus.current && document.activeElement === document.body)
      restoreMenuFocus(restore.current);
    returnFocus.current = false;
  }, [disabled, open]);
  const focus = (index: number) => {
    const items =
      menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    items?.[index]?.focus({ preventScroll: true });
    items?.[index]?.scrollIntoView({ block: "nearest" });
  };
  const close = () => {
    returnFocus.current = true;
    menu.current?.hidePopover();
    restoreMenuFocus(restore.current);
  };
  const show = () => {
    menu.current?.showPopover();
    focus(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
  };
  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        value={value}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        className={`select-trigger ${className}`}
        style={{ anchorName: anchor }}
        title={title}
        disabled={disabled || !options.length}
        popoverTarget={menuId}
        onPointerDown={() => {
          if (!open)
            restore.current = menuFocusTarget(document.activeElement, true);
        }}
        onClick={(event) => {
          event.preventDefault();
          if (menu.current?.matches(":popover-open")) close();
          else {
            if (!event.detail) restore.current = trigger.current;
            show();
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          restore.current = trigger.current;
          show();
        }}
      >
        <span>{options.find((option) => option.value === value)?.label}</span>
        <CaretDown size={10} />
      </button>
      <div
        ref={menu}
        id={menuId}
        className="select-menu"
        style={{ positionAnchor: anchor }}
        role="listbox"
        aria-label={`${label} options`}
        popover="auto"
        onToggle={(event) => {
          const opening = event.newState === "open";
          setOpen(opening);
          search.current = { text: "", at: 0 };
          if (
            !opening &&
            (document.activeElement === document.body ||
              document.activeElement === trigger.current ||
              menu.current?.contains(document.activeElement))
          )
            restoreMenuFocus(restore.current);
        }}
        onKeyDown={(event) => {
          const index = options.findIndex(
            (_, index) =>
              menu.current?.children[index] === document.activeElement,
          );
          if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            event.stopPropagation();
            close();
            return;
          }
          const next = menuStep(
            event,
            options.map((option) => option.label),
            index,
            search.current,
          );
          if (next === null) return;
          event.preventDefault();
          event.stopPropagation();
          focus(next);
        }}
      >
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            role="option"
            aria-selected={value === option.value}
            tabIndex={-1}
            onClick={() => {
              if (option.value !== value) onChange(option.value);
              close();
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </>
  );
}
