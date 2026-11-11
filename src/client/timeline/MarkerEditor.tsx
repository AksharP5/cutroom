import { useEffect, useRef, useState } from "react";
import { Trash, X } from "@phosphor-icons/react";
import type { Marker } from "../../shared/timeline/schema";
import "./markers.css";

// Keep the engine's stored colour names; the design maps these to a quieter palette.
const colors = [
  ["blue", "Grey", "--marker-grey"],
  ["green", "Green", "--marker-green"],
  ["purple", "Violet", "--marker-violet"],
  ["pink", "Rose", "--marker-rose"],
  ["yellow", "Sand", "--marker-sand"],
] as const satisfies readonly (readonly [Marker["color"], string, string])[];

export function MarkerEditor({
  marker,
  anchor,
  onClose,
  onSave,
  onDelete,
}: {
  marker: Marker;
  anchor: { x: number; y: number };
  onClose(): void;
  onSave(marker: Marker): Promise<boolean>;
  onDelete(): Promise<boolean>;
}) {
  const popover = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(marker.name);
  const [color, setColor] = useState(marker.color);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const opener = document.activeElement;
    popover.current?.showPopover();
    field.current?.focus();
    field.current?.select();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);

  async function save(remove = false) {
    if (saving) return;
    if (!remove && name === marker.name && color === marker.color) {
      onClose();
      return;
    }
    setSaving(true);
    const accepted = remove
      ? await onDelete()
      : await onSave({ ...marker, name, color });
    if (accepted) onClose();
    else setSaving(false);
  }

  return (
    <div
      ref={popover}
      popover="auto"
      className="marker-editor"
      role="dialog"
      aria-label="Edit marker"
      style={{
        "--marker-editor-x": `${anchor.x}px`,
        "--marker-editor-y": `${anchor.y}px`,
      }}
      onToggle={(event) => {
        if (event.newState === "closed") onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="marker-editor-heading">
          <label htmlFor="marker-name">Marker name</label>
          <button
            type="button"
            className="icon-button"
            aria-label="Close marker"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        <input
          id="marker-name"
          ref={field}
          value={name}
          maxLength={500}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="marker-colors" role="group" aria-label="Marker colour">
          {colors.map(([value, label, token]) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              title={label}
              aria-pressed={
                color === value ||
                (value === "blue" && color === "cyan") ||
                (value === "pink" && color === "red")
              }
              style={{ "--marker": `var(${token})` }}
              onClick={() => setColor(value)}
            />
          ))}
        </div>
        <div className="marker-editor-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Delete marker"
            disabled={saving}
            onClick={() => void save(true)}
          >
            <Trash />
          </button>
          <button className="secondary-button" disabled={saving}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
