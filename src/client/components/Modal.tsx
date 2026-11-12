import { useEffect, useId, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { X } from "@phosphor-icons/react";

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  initialFocus,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    initialFocus?.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        !document.querySelector("dialog[open]")
      )
        opener.focus({ preventScroll: true });
    };
  }, [initialFocus]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`modal ${wide ? "modal-wide" : ""}`}
      onCancel={onClose}
      onKeyDown={(event) => {
        if (
          event.key !== "Tab" ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button, a[href], input, select, textarea, [tabindex]",
          ),
        ].filter(
          (control) =>
            control.tabIndex >= 0 &&
            !control.matches(":disabled") &&
            control.checkVisibility(),
        );
        const first = controls[0];
        const last = controls.at(-1);
        const target =
          event.shiftKey && document.activeElement === first
            ? last
            : !event.shiftKey && document.activeElement === last
              ? first
              : null;
        if (!target) return;
        event.preventDefault();
        target.focus();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
