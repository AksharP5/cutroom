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
import { reachedByKeyboard, restoreMenuFocus } from "../../keymap";
import { SelectMenu } from "../../components/SelectMenu";
import { FontMenu } from "./FontMenu";
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
/** Shadow and stroke switched on start dark and soft enough to lift white words off footage. */
const DEFAULT_SHADOW: NonNullable<Title["shadow"]> = {
  color: "#000000b3",
  blur: 12,
};
const DEFAULT_STROKE: NonNullable<Title["stroke"]> = {
  color: "#000000",
  width: 3,
};
const MAX_SIZE = 2000;
const MIN_SIZE = 8;
const MAX_MOTION_FRAMES = 100_000;
const MAX_SHADOW_BLUR = 200;
const MAX_STROKE_WIDTH = 100;

export function Row({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="inspector-field">
      <span className="inspector-label">{label}</span>
      <div className="inspector-value">{children}</div>
    </div>
  );
}

/** Typed text that commits once, on Enter or on leaving the field. Escape puts the value back. */
export function DraftField({
  label,
  value,
  disabled,
  className,
  parse,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  className?: string;
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
      className={className}
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
export function ColourFields({
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
      // A colour picked with the pointer hands the transport keys back, as a toggle click does.
      if (!reachedByKeyboard(input)) restoreMenuFocus(null);
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
            <FontMenu
              projectId={projectId}
              value={title.font}
              fonts={fonts}
              unset="Default"
              disabled={disabled}
              onChange={(font) => edit({ font })}
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
              // A radio group moves its choice with the arrows, as native radios do, so the
              // timeline's arrow keys never see them.
              onKeyDown={(event) => {
                const step = {
                  ArrowLeft: -1,
                  ArrowUp: -1,
                  ArrowRight: 1,
                  ArrowDown: 1,
                }[event.key];
                const last = TITLE_ALIGNMENTS.length - 1;
                const current = TITLE_ALIGNMENTS.indexOf(title.align);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? last
                      : step === undefined
                        ? null
                        : (current + step + last + 1) % (last + 1);
                if (next === null || disabled) return;
                event.preventDefault();
                const align = TITLE_ALIGNMENTS[next]!;
                if (align !== title.align) edit({ align });
                event.currentTarget
                  .querySelectorAll<HTMLButtonElement>("[role=radio]")
                  [next]?.focus();
              }}
            >
              {TITLE_ALIGNMENTS.map((align) => {
                const Icon = ALIGN_ICONS[align];
                return (
                  <button
                    key={align}
                    type="button"
                    role="radio"
                    aria-checked={title.align === align}
                    tabIndex={title.align === align ? 0 : -1}
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
              <AlphaColourFields
                key={clip.id}
                label="Plate"
                value={title.plate}
                disabled={disabled}
                onCommit={(plate) => edit({ plate })}
              />
            )}
          </Row>
          <Row label="Shadow">
            <input
              type="checkbox"
              aria-label="Shadow"
              checked={title.shadow !== null}
              disabled={disabled}
              onChange={(event) =>
                edit({ shadow: event.target.checked ? DEFAULT_SHADOW : null })
              }
              onKeyDown={(event) => event.stopPropagation()}
            />
            {title.shadow !== null && (
              <AlphaColourFields
                key={clip.id}
                label="Shadow"
                value={title.shadow.color}
                disabled={disabled}
                onCommit={(color) =>
                  title.shadow && edit({ shadow: { ...title.shadow, color } })
                }
              />
            )}
          </Row>
          {title.shadow !== null && (
            <ValueField
              key={`${clip.id}:shadow-blur`}
              label="Blur"
              value={title.shadow.blur}
              unit="pixels"
              min={0}
              max={MAX_SHADOW_BLUR}
              fps={fps}
              disabled={disabled}
              tip="Shadow blur in composition pixels. Drag the label or use Up/Down. Shift for 10 pixels."
              onCommit={(blur) => {
                if (blur === null || !title.shadow) return;
                const whole = Math.round(blur);
                if (whole !== title.shadow.blur)
                  edit({ shadow: { ...title.shadow, blur: whole } });
              }}
            />
          )}
          <Row label="Stroke">
            <input
              type="checkbox"
              aria-label="Stroke"
              checked={title.stroke !== null}
              disabled={disabled}
              onChange={(event) =>
                edit({ stroke: event.target.checked ? DEFAULT_STROKE : null })
              }
              onKeyDown={(event) => event.stopPropagation()}
            />
            {title.stroke !== null && (
              <ColourFields
                key={clip.id}
                label="Stroke colour"
                value={title.stroke.color}
                disabled={disabled}
                onCommit={(color) =>
                  title.stroke && edit({ stroke: { ...title.stroke, color } })
                }
              />
            )}
          </Row>
          {title.stroke !== null && (
            <ValueField
              key={`${clip.id}:stroke-width`}
              label="Width"
              value={title.stroke.width}
              unit="pixels"
              min={1}
              max={MAX_STROKE_WIDTH}
              fps={fps}
              disabled={disabled}
              tip="Stroke thickness outside the letters in composition pixels. Drag the label or use Up/Down. Shift for 10 pixels."
              onCommit={(width) => {
                if (width === null || !title.stroke) return;
                const whole = Math.round(width);
                if (whole !== title.stroke.width)
                  edit({ stroke: { ...title.stroke, width: whole } });
              }}
            />
          )}
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

/** One `#rrggbbaa` value, such as a plate: the colour and its opacity are edited apart. */
export function AlphaColourFields({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCommit(value: string): void;
}) {
  const colour = value.slice(0, 7);
  const alpha = value.slice(7);
  return (
    <>
      <ColourFields
        label={`${label} colour`}
        value={colour}
        disabled={disabled}
        onCommit={(next) => onCommit(`${next}${alpha}`)}
      />
      <DraftField
        label={`${label} opacity`}
        className="inspector-alpha"
        value={formatPercent(
          Math.round((Number.parseInt(alpha, 16) / 255) * 100) / 100,
        )}
        disabled={disabled}
        parse={(text) => {
          const opacity = parseField(text, "percent", { num: 1, den: 1 });
          if (opacity > 1) throw new Error(`${label} opacity stops at 100%.`);
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
