import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CaretRight,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
} from "@phosphor-icons/react";
import {
  TITLE_ALIGNMENTS,
  TITLE_MOTIONS,
  TITLE_POSITIONS,
  TITLE_WEIGHTS,
} from "../../../shared/timeline/schema";
import type {
  Clip,
  CommandInput,
  Fps,
  Title,
  TitleEdit,
} from "../../../shared/timeline/schema";
import { formatPercent } from "../../../shared/timeline/labels";
import { SelectMenu } from "../../components/SelectMenu";
import { showToast } from "../../workspace";
import { editTimeline } from "../timeline";
import { parseField } from "./fields";
import { ValueField } from "./ValueField";

const POSITION_LABELS: Record<Title["position"], string> = {
  "lower-left": "Lower left",
  "lower-center": "Lower centre",
  "lower-right": "Lower right",
  center: "Centre",
  top: "Top",
};
const MOTION_LABELS: Record<Title["in"]["preset"], string> = {
  none: "None",
  fade: "Fade",
  slide: "Slide",
  scale: "Scale",
  wipe: "Wipe",
};
const WEIGHT_LABELS: Record<Title["weight"], string> = {
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
};
const ALIGN_ICONS = {
  left: TextAlignLeft,
  center: TextAlignCenter,
  right: TextAlignRight,
};
const ALIGN_LABELS: Record<Title["align"], string> = {
  left: "Align left",
  center: "Align centre",
  right: "Align right",
};
/** A plate switched on starts as the lower-third black the MCP examples use. */
const DEFAULT_PLATE = "#000000b3";
const MAX_SIZE = 2000;
const MIN_SIZE = 8;
const MAX_MOTION_FRAMES = 100_000;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inspector-field">
      <span className="inspector-label">{label}</span>
      <div className="inspector-value">{children}</div>
    </div>
  );
}

/** Typed text that commits once, on Enter or on leaving the field. Escape puts the value back. */
function DraftField({
  label,
  value,
  disabled,
  parse,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  /** The canonical value, or throws with what to type instead. */
  parse(text: string): string;
  onCommit(value: string): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return (
    <input
      type="text"
      aria-label={label}
      spellCheck={false}
      disabled={disabled}
      value={draft ?? value}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const typed = cancelled.current ? null : draft;
        cancelled.current = false;
        setDraft(null);
        if (typed === null) return;
        try {
          const next = parse(typed);
          if (next !== value) onCommit(next);
        } catch (error) {
          showToast(error instanceof Error ? error.message : String(error));
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        cancelled.current = event.key === "Escape";
        // Leaving the field returns Space, undo and the other shortcuts to the editor.
        event.currentTarget.blur();
      }}
    />
  );
}

const parseHex = (text: string) => {
  const hex = text.trim().replace(/^#?/, "#").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex))
    throw new Error("Enter a colour as six hex digits, such as #ffcc00.");
  return hex;
};

/**
 * The system colour picker behind a swatch, with the same colour as typed hex. The picker reports
 * every colour it passes over; only the one it closes on is committed, so a pick is one edit.
 */
function ColourFields({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCommit(hex: string): void;
}) {
  const swatch = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const saved = useRef(value);
  saved.current = value;
  useEffect(() => {
    const input = swatch.current;
    if (!input) return;
    // React's onChange is the input event; the picker's own change event marks the final colour.
    const change = () => {
      setPicking(null);
      if (input.value !== saved.current) commit.current(input.value);
    };
    input.addEventListener("change", change);
    return () => input.removeEventListener("change", change);
  }, []);
  return (
    <>
      <input
        ref={swatch}
        type="color"
        className="inspector-swatch"
        aria-label={label}
        disabled={disabled}
        value={picking ?? value}
        onChange={(event) => setPicking(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <DraftField
        label={`${label} hex`}
        value={value}
        disabled={disabled}
        parse={parseHex}
        onCommit={onCommit}
      />
    </>
  );
}

/**
 * A title's look and motion. Every control sends one `setClip.title` change, so each is one undo
 * step. `fonts` are the families the project declares; a title can use no other.
 */
export function TitleSection({
  projectId,
  clip,
  fps,
  fonts,
  disabled,
  open,
  onToggle,
}: {
  projectId: string;
  clip: Clip;
  fps: Fps;
  fonts: readonly string[];
  disabled: boolean;
  open: boolean;
  onToggle(open: boolean): void;
}) {
  const title = clip.title;
  const edit = (
    change: TitleEdit,
    also: Partial<Extract<CommandInput, { type: "setClip" }>> = {},
  ) => {
    void editTimeline(projectId, "Edit title", () => [
      { type: "setClip", clipId: clip.id, title: change, ...also },
    ]);
  };
  return (
    <details
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="inspector-section inspector-title"
    >
      <summary>
        <CaretRight size={10} aria-hidden />
        Title
      </summary>
      {!title ? (
        <p className="inspector-reason">{clip.sourceRestrictions?.title}</p>
      ) : (
        <>
          <Row label="Font">
            <SelectMenu
              label="Font"
              value={title.font ?? ""}
              disabled={disabled}
              options={[
                { value: "", label: "Default" },
                ...fonts.map((font) => ({ value: font, label: font })),
              ]}
              onChange={(font) => edit({ font: font || null })}
            />
          </Row>
          <Row label="Weight">
            <SelectMenu
              label="Weight"
              value={String(title.weight)}
              disabled={disabled}
              options={TITLE_WEIGHTS.map((weight) => ({
                value: String(weight),
                label: WEIGHT_LABELS[weight],
              }))}
              onChange={(value) => {
                const weight = TITLE_WEIGHTS.find(
                  (weight) => String(weight) === value,
                );
                if (weight) edit({ weight });
              }}
            />
          </Row>
          <ValueField
            key={`${clip.id}:size`}
            label="Size"
            value={title.size}
            unit="pixels"
            min={MIN_SIZE}
            max={MAX_SIZE}
            fps={fps}
            disabled={disabled}
            tip="Font size in composition pixels. Drag the label or use Up/Down. Shift for 10 pixels."
            onCommit={(size) => {
              if (size === null) return;
              const whole = Math.round(size);
              if (whole !== title.size) edit({ size: whole });
            }}
          />
          <Row label="Colour">
            <ColourFields
              key={clip.id}
              label="Colour"
              value={title.color}
              disabled={disabled}
              onCommit={(color) => edit({ color })}
            />
          </Row>
          <Row label="Align">
            <div
              className="inspector-segments"
              role="radiogroup"
              aria-label="Align"
            >
              {TITLE_ALIGNMENTS.map((align) => {
                const Icon = ALIGN_ICONS[align];
                return (
                  <button
                    key={align}
                    type="button"
                    role="radio"
                    aria-checked={title.align === align}
                    aria-label={ALIGN_LABELS[align]}
                    title={ALIGN_LABELS[align]}
                    disabled={disabled}
                    onClick={() => {
                      if (title.align !== align) edit({ align });
                    }}
                  >
                    <Icon size={14} aria-hidden />
                  </button>
                );
              })}
            </div>
          </Row>
          <Row label="Position">
            <SelectMenu
              label="Position"
              value={title.position}
              disabled={disabled}
              options={TITLE_POSITIONS.map((position) => ({
                value: position,
                label: POSITION_LABELS[position],
              }))}
              // A preset is a place on the picture, so an earlier drag away from one is dropped.
              onChange={(position) => edit({ position }, { x: null, y: null })}
            />
          </Row>
          <Row label="Plate">
            <input
              type="checkbox"
              aria-label="Plate"
              checked={title.plate !== null}
              disabled={disabled}
              onChange={(event) =>
                edit({ plate: event.target.checked ? DEFAULT_PLATE : null })
              }
              onKeyDown={(event) => event.stopPropagation()}
            />
            {title.plate !== null && (
              <PlateFields
                key={clip.id}
                plate={title.plate}
                disabled={disabled}
                onCommit={(plate) => edit({ plate })}
              />
            )}
          </Row>
          {(["in", "out"] as const).map((edge) => (
            <ValueField
              key={`${clip.id}:${edge}`}
              label={edge === "in" ? "In" : "Out"}
              value={title[edge].frames}
              unit="timecode"
              max={MAX_MOTION_FRAMES}
              fps={fps}
              disabled={disabled || title[edge].preset === "none"}
              before={
                <SelectMenu
                  label={edge === "in" ? "In preset" : "Out preset"}
                  value={title[edge].preset}
                  disabled={disabled}
                  options={TITLE_MOTIONS.map((preset) => ({
                    value: preset,
                    label: MOTION_LABELS[preset],
                  }))}
                  onChange={(preset) => edit({ [edge]: { preset } })}
                />
              }
              onCommit={(frames) => {
                if (frames !== null) edit({ [edge]: { frames } });
              }}
            />
          ))}
        </>
      )}
    </details>
  );
}

/** A plate is one `#rrggbbaa` value: the colour and its opacity are edited apart. */
function PlateFields({
  plate,
  disabled,
  onCommit,
}: {
  plate: string;
  disabled: boolean;
  onCommit(plate: string): void;
}) {
  const colour = plate.slice(0, 7);
  const alpha = plate.slice(7);
  return (
    <>
      <ColourFields
        label="Plate colour"
        value={colour}
        disabled={disabled}
        onCommit={(next) => onCommit(`${next}${alpha}`)}
      />
      <DraftField
        label="Plate opacity"
        value={formatPercent(
          Math.round((Number.parseInt(alpha, 16) / 255) * 100) / 100,
        )}
        disabled={disabled}
        parse={(text) => {
          const opacity = parseField(text, "percent", { num: 1, den: 1 });
          if (opacity > 1) throw new Error("Plate opacity stops at 100%.");
          return formatPercent(Math.round(opacity * 100) / 100);
        }}
        onCommit={(percent) =>
          onCommit(
            `${colour}${Math.round((Number.parseFloat(percent) / 100) * 255)
              .toString(16)
              .padStart(2, "0")}`,
          )
        }
      />
    </>
  );
}
