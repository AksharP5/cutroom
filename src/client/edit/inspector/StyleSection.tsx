import { ArrowCounterClockwise, CaretRight } from "@phosphor-icons/react";
import {
  STYLE_ALIGNMENTS,
  STYLE_CASES,
  STYLE_FITS,
  STYLE_WEIGHTS,
} from "../../../shared/timeline/elementStyle";
import type {
  ElementStyle,
  ElementStyleEdit,
} from "../../../shared/timeline/elementStyle";
import type { Clip, Fps } from "../../../shared/timeline/schema";
import { SelectMenu } from "../../components/SelectMenu";
import { editTimeline } from "../timeline";
import { AlphaColourFields, Row } from "./TitleSection";
import { FieldRow, ValueCell, ValueField } from "./ValueField";

const WEIGHT_LABELS: Record<(typeof STYLE_WEIGHTS)[number], string> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};
const ALIGN_LABELS: Record<(typeof STYLE_ALIGNMENTS)[number], string> = {
  left: "Left",
  center: "Centre",
  right: "Right",
  justify: "Justify",
};
const CASE_LABELS: Record<(typeof STYLE_CASES)[number], string> = {
  none: "As typed",
  uppercase: "Uppercase",
  lowercase: "Lowercase",
  capitalize: "Capitalise",
};
const FIT_LABELS: Record<(typeof STYLE_FITS)[number], string> = {
  contain: "Contain",
  cover: "Cover",
  fill: "Stretch",
  none: "Original size",
  "scale-down": "Shrink to fit",
};
/** Switched on, text starts white, a fill translucent black and a shadow soft and dark. */
const DEFAULT_COLOUR = "#ffffff";
const DEFAULT_FILL = "#000000b3";
const DEFAULT_GRADIENT = { from: "#000000", to: "#ffffff", angle: 180 };
const DEFAULT_SHADOW: NonNullable<ElementStyle["shadow"]> = {
  x: 0,
  y: 4,
  blur: 12,
  color: "#000000b3",
};
const auto = (what: string) =>
  `${what}. Auto, or a double-click on the label, leaves it to the composition's styles.`;

type Props = {
  projectId: string;
  clip: Clip;
  fps: Fps;
  disabled: boolean;
};

/** One `setClip.style` per control, so each change is one undo step. */
const edit = (projectId: string, clip: Clip, style: ElementStyleEdit) =>
  void editTimeline(projectId, "Edit style", () => [
    { type: "setClip", clipId: clip.id, style },
  ]);

/** A colour that may carry alpha, edited as colour and opacity. Opaque values drop their alpha. */
function ColourRow({
  label,
  value,
  initial,
  disabled,
  onCommit,
}: {
  label: string;
  value: string | undefined;
  initial: string;
  disabled: boolean;
  onCommit(value: string | null): void;
}) {
  return (
    <Row label={label}>
      <input
        type="checkbox"
        aria-label={label}
        checked={value !== undefined}
        disabled={disabled}
        onChange={(event) => onCommit(event.target.checked ? initial : null)}
        onKeyDown={(event) => event.stopPropagation()}
      />
      {value !== undefined && (
        <ColourFields
          label={label}
          value={value}
          disabled={disabled}
          onCommit={onCommit}
        />
      )}
    </Row>
  );
}

function ColourFields({
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
  return (
    <AlphaColourFields
      label={label}
      value={value.length === 7 ? `${value}ff` : value}
      disabled={disabled}
      onCommit={(next) =>
        onCommit(next.endsWith("ff") ? next.slice(0, 7) : next)
      }
    />
  );
}

/** A menu whose first choice, Auto, leaves the property to the composition. */
function ChoiceRow<const Value extends string>({
  label,
  value,
  options,
  labels,
  disabled,
  onChange,
}: {
  label: string;
  value: Value | undefined;
  options: readonly Value[];
  labels: Record<Value, string>;
  disabled: boolean;
  onChange(value: Value | null): void;
}) {
  return (
    <Row label={label}>
      <SelectMenu
        label={label}
        value={value ?? ""}
        disabled={disabled}
        options={[
          { value: "", label: "Auto" },
          ...options.map((option) => ({
            value: option,
            label: labels[option],
          })),
        ]}
        onChange={(next) =>
          onChange(options.find((option) => option === next) ?? null)
        }
      />
    </Row>
  );
}

/** How the words of a text element look. */
function TextStyleFields({
  projectId,
  clip,
  fps,
  fonts,
  disabled,
}: Props & { fonts: readonly string[] }) {
  const style = clip.style;
  const set = (change: ElementStyleEdit) => edit(projectId, clip, change);
  return (
    <>
      <Row label="Font">
        <SelectMenu
          label="Font"
          value={style.fontFamily ?? ""}
          disabled={disabled}
          options={[
            { value: "", label: "Auto" },
            ...fonts.map((font) => ({ value: font, label: font })),
          ]}
          onChange={(font) => set({ fontFamily: font || null })}
        />
      </Row>
      <Row label="Weight">
        <SelectMenu
          label="Weight"
          value={style.fontWeight === undefined ? "" : String(style.fontWeight)}
          disabled={disabled}
          options={[
            { value: "", label: "Auto" },
            ...STYLE_WEIGHTS.map((weight) => ({
              value: String(weight),
              label: WEIGHT_LABELS[weight],
            })),
          ]}
          onChange={(value) =>
            set({
              fontWeight:
                STYLE_WEIGHTS.find((weight) => String(weight) === value) ??
                null,
            })
          }
        />
      </Row>
      <ValueField
        key={`${clip.id}:font-size`}
        label="Size"
        value={style.fontSize ?? null}
        unit="pixels"
        allowAuto
        min={1}
        max={2000}
        fps={fps}
        disabled={disabled}
        tip={auto("Font size in composition pixels")}
        onReset={() => set({ fontSize: null })}
        onCommit={(fontSize) => set({ fontSize })}
      />
      <ValueField
        key={`${clip.id}:tracking`}
        label="Tracking"
        value={style.letterSpacing ?? null}
        unit="percent"
        allowAuto
        min={-1}
        max={2}
        fps={fps}
        disabled={disabled}
        tip={auto("Space between letters, as a percentage of the font size")}
        onReset={() => set({ letterSpacing: null })}
        onCommit={(letterSpacing) => set({ letterSpacing })}
      />
      <ValueField
        key={`${clip.id}:leading`}
        label="Leading"
        value={style.lineHeight ?? null}
        unit="percent"
        allowAuto
        min={0.5}
        max={5}
        fps={fps}
        disabled={disabled}
        tip={auto("Line height, as a percentage of the font size")}
        onReset={() => set({ lineHeight: null })}
        onCommit={(lineHeight) => set({ lineHeight })}
      />
      <ColourRow
        key={`${clip.id}:colour`}
        label="Colour"
        value={style.color}
        initial={DEFAULT_COLOUR}
        disabled={disabled}
        onCommit={(color) => set({ color })}
      />
      <ChoiceRow
        label="Align"
        value={style.textAlign}
        options={STYLE_ALIGNMENTS}
        labels={ALIGN_LABELS}
        disabled={disabled}
        onChange={(textAlign) => set({ textAlign })}
      />
      <ChoiceRow
        label="Case"
        value={style.textTransform}
        options={STYLE_CASES}
        labels={CASE_LABELS}
        disabled={disabled}
        onChange={(textTransform) => set({ textTransform })}
      />
    </>
  );
}

/**
 * The look of any visual clip that is not a title: its words' style when it has words, then its
 * box, fill, corners, shadow and blur. Each row starts at Auto, where the composition's own
 * styles decide; setting one writes it inline on the clip.
 */
export function StyleSection({
  projectId,
  clip,
  fps,
  fonts,
  disabled,
  open,
  onToggle,
}: Props & {
  fonts: readonly string[];
  open: boolean;
  onToggle(open: boolean): void;
}) {
  const style = clip.style;
  const set = (change: ElementStyleEdit) => edit(projectId, clip, change);
  const media = clip.kind === "video" || clip.kind === "image";
  const { fill, shadow } = style;
  const gradient = typeof fill === "object" ? fill : null;
  const fields = Object.keys(style);
  return (
    <details
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="inspector-section"
    >
      <summary>
        <CaretRight size={10} aria-hidden />
        Style
      </summary>
      <button
        type="button"
        className="inspector-section-reset"
        aria-label="Reset style"
        title="Reset style. Every row goes back to Auto."
        disabled={!fields.length || disabled}
        onClick={() =>
          set(Object.fromEntries(fields.map((field) => [field, null])))
        }
      >
        <ArrowCounterClockwise size={12} aria-hidden />
      </button>
      {clip.kind === "element" && clip.text !== null && (
        <TextStyleFields
          projectId={projectId}
          clip={clip}
          fps={fps}
          fonts={fonts}
          disabled={disabled}
        />
      )}
      <FieldRow
        label="Box"
        disabled={disabled}
        onReset={() => set({ width: null, height: null })}
      >
        {(["width", "height"] as const).map((field) => (
          <ValueCell
            key={`${clip.id}:${field}`}
            axis={field === "width" ? "W" : "H"}
            label={field === "width" ? "Width" : "Height"}
            value={style[field] ?? null}
            unit="pixels"
            allowAuto
            bare
            max={100_000}
            fps={fps}
            disabled={disabled}
            tip={auto(`Layout ${field} in composition pixels`)}
            onCommit={(value) => set({ [field]: value })}
          />
        ))}
      </FieldRow>
      {media && (
        <ChoiceRow
          label="Fit"
          value={style.objectFit}
          options={STYLE_FITS}
          labels={FIT_LABELS}
          disabled={disabled}
          onChange={(objectFit) => set({ objectFit })}
        />
      )}
      <Row label="Fill">
        <SelectMenu
          label="Fill"
          value={fill === undefined ? "" : gradient ? "gradient" : "colour"}
          disabled={disabled}
          options={[
            { value: "", label: "Auto" },
            { value: "colour", label: "Colour" },
            { value: "gradient", label: "Gradient" },
          ]}
          onChange={(kind) =>
            set({
              fill:
                kind === "colour"
                  ? (gradient?.from ?? DEFAULT_FILL)
                  : kind === "gradient"
                    ? typeof fill === "string"
                      ? { ...DEFAULT_GRADIENT, from: fill }
                      : DEFAULT_GRADIENT
                    : null,
            })
          }
        />
      </Row>
      {typeof fill === "string" && (
        <Row label="Colour">
          <ColourFields
            key={`${clip.id}:fill`}
            label="Fill"
            value={fill}
            disabled={disabled}
            onCommit={(next) => set({ fill: next })}
          />
        </Row>
      )}
      {gradient && (
        <>
          {(["from", "to"] as const).map((stop) => (
            <Row key={stop} label={stop === "from" ? "From" : "To"}>
              <ColourFields
                key={`${clip.id}:${stop}`}
                label={`Gradient ${stop}`}
                value={gradient[stop]}
                disabled={disabled}
                onCommit={(next) =>
                  set({ fill: { ...gradient, [stop]: next } })
                }
              />
            </Row>
          ))}
          <ValueField
            key={`${clip.id}:angle`}
            label="Angle"
            value={gradient.angle}
            unit="degrees"
            max={360}
            fps={fps}
            disabled={disabled}
            tip="Gradient direction: 90° runs left to right, 180° top to bottom."
            onCommit={(angle) => {
              if (angle !== null) set({ fill: { ...gradient, angle } });
            }}
          />
        </>
      )}
      <ValueField
        key={`${clip.id}:radius`}
        label="Radius"
        value={style.borderRadius ?? null}
        unit="pixels"
        allowAuto
        max={10_000}
        fps={fps}
        disabled={disabled}
        tip={auto("Corner radius in composition pixels")}
        onReset={() => set({ borderRadius: null })}
        onCommit={(borderRadius) => set({ borderRadius })}
      />
      <Row label="Shadow">
        <input
          type="checkbox"
          aria-label="Shadow"
          checked={shadow !== undefined}
          disabled={disabled}
          onChange={(event) =>
            set({ shadow: event.target.checked ? DEFAULT_SHADOW : null })
          }
          onKeyDown={(event) => event.stopPropagation()}
        />
        {shadow && (
          <ColourFields
            key={`${clip.id}:shadow`}
            label="Shadow"
            value={shadow.color}
            disabled={disabled}
            onCommit={(color) => set({ shadow: { ...shadow, color } })}
          />
        )}
      </Row>
      {shadow && (
        <>
          <FieldRow label="Offset" disabled={disabled}>
            {(["x", "y"] as const).map((axis) => (
              <ValueCell
                key={`${clip.id}:shadow-${axis}`}
                axis={axis.toUpperCase()}
                label={`Shadow ${axis.toUpperCase()}`}
                value={shadow[axis]}
                unit="pixels"
                bare
                min={-2000}
                max={2000}
                fps={fps}
                disabled={disabled}
                onCommit={(value) => {
                  if (value !== null)
                    set({ shadow: { ...shadow, [axis]: value } });
                }}
              />
            ))}
          </FieldRow>
          <ValueField
            key={`${clip.id}:shadow-blur`}
            label="Softness"
            value={shadow.blur}
            unit="pixels"
            max={500}
            fps={fps}
            disabled={disabled}
            tip="Shadow blur in composition pixels."
            onCommit={(blur) => {
              if (blur !== null) set({ shadow: { ...shadow, blur } });
            }}
          />
        </>
      )}
      <ValueField
        key={`${clip.id}:blur`}
        label="Blur"
        value={style.blur ?? null}
        unit="pixels"
        allowAuto
        max={500}
        fps={fps}
        disabled={disabled}
        tip={auto("Blur radius in composition pixels")}
        onReset={() => set({ blur: null })}
        onCommit={(blur) => set({ blur })}
      />
    </details>
  );
}
