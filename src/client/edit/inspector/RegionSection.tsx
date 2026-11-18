import { useContext } from "react";
import { CaretRight } from "@phosphor-icons/react";
import {
  MAX_ZOOM,
  REGION_AREAS,
  REGION_EASES,
  REGION_EASE_CURVES,
  zoomScale,
} from "../../../shared/timeline/region";
import type {
  Region,
  RegionEase,
  RegionEdit,
} from "../../../shared/timeline/region";
import { REGION_NAMES } from "../../../shared/timeline/labels";
import type { Clip, Fps } from "../../../shared/timeline/schema";
import { EditorToolsContext } from "../../editor/EditorTools";
import { editTimeline } from "../timeline";
import { zoomBoxAt } from "../regionCommands";
import { Row } from "./TitleSection";
import { ValueField } from "./ValueField";
import "../region.css";

const EASE_LABELS: Record<RegionEase, string> = {
  linear: "Linear",
  ease: "Ease",
  "ease-in": "Ease in",
  "ease-out": "Ease out",
  "ease-in-out": "Ease in and out",
  "expo-in": "Exponential in",
  "expo-out": "Exponential out",
};
const EFFECTS = ["zoom", "blur", "highlight"] as const;
/** Ramp lengths and pixel sizes the schema accepts. */
const MAX_RAMP = 100_000;
const MAX_BLUR = 100;
const MAX_RADIUS = 2000;
const MAX_FEATHER = 500;

/** An ease drawn as its curve: time across, progress up. */
function Curve({ ease }: { ease: RegionEase }) {
  const [x1, y1, x2, y2] = REGION_EASE_CURVES[ease];
  return (
    <svg viewBox="-2 -2 28 20" aria-hidden="true">
      <path
        d={`M0 16C${x1 * 24} ${16 - y1 * 16} ${x2 * 24} ${16 - y2 * 16} 24 0`}
      />
    </svg>
  );
}

function Segments<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  disabled: boolean;
  onChange(value: T): void;
}) {
  return (
    <div
      className="inspector-region-segments"
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A clip's zoom, or an adjustment layer's zoom, blur or highlight: its strength, its ramps and
 * their ease. The box itself is aimed on the picture with the Zoom and highlight tool.
 */
export function RegionSection({
  projectId,
  clip,
  region,
  fps,
  disabled,
  open,
  onToggle,
}: {
  projectId: string;
  clip: Clip;
  region: Region;
  fps: Fps;
  disabled: boolean;
  open: boolean;
  onToggle(open: boolean): void;
}) {
  const tools = useContext(EditorToolsContext);
  const name = REGION_NAMES[region.effect];
  const edit = (
    change: RegionEdit | null,
    label = `Edit ${name.toLowerCase()}`,
  ) =>
    void editTimeline(projectId, label, () => [
      { type: "setClip", clipId: clip.id, region: change },
    ]);
  const zoom = region.effect === "zoom";
  const centre = {
    x: region.box.x + region.box.width / 2,
    y: region.box.y + region.box.height / 2,
  };
  return (
    <details
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="inspector-section inspector-region"
    >
      <summary>
        <CaretRight size={10} aria-hidden />
        {clip.adjustment ? "Adjustment" : name}
      </summary>
      {clip.adjustment && (
        <Row label="Effect">
          <Segments
            label="Effect"
            options={EFFECTS.map((value) => ({
              value,
              label: REGION_NAMES[value],
            }))}
            value={region.effect}
            disabled={disabled}
            onChange={(effect) => edit({ effect }, "Change effect")}
          />
        </Row>
      )}
      {zoom && (
        <ValueField
          key={`${clip.id}:zoom`}
          label="Zoom"
          value={zoomScale(region)}
          unit="percent"
          min={1}
          max={MAX_ZOOM}
          fps={fps}
          disabled={disabled}
          tip="How far the box is magnified to fill the frame. Scroll over the picture with the Zoom and highlight tool to change it there."
          onCommit={(scale) => {
            if (scale === null) return;
            edit({ box: zoomBoxAt(centre.x, centre.y, 1 / scale) });
          }}
        />
      )}
      {region.effect === "blur" && (
        <Row label="Area">
          <Segments
            label="Area"
            options={REGION_AREAS.map((value) => ({
              value,
              label: value === "inside" ? "Inside" : "Outside",
            }))}
            value={region.area}
            disabled={disabled}
            onChange={(area) => edit({ area })}
          />
        </Row>
      )}
      {region.effect === "highlight" && (
        <ValueField
          key={`${clip.id}:dim`}
          label="Dim"
          value={region.dim}
          unit="percent"
          min={0}
          max={1}
          fps={fps}
          disabled={disabled}
          onCommit={(dim) => {
            if (dim !== null) edit({ dim });
          }}
        />
      )}
      {!zoom && (
        <>
          <ValueField
            key={`${clip.id}:blur`}
            label="Blur"
            value={region.blur}
            unit="pixels"
            min={0}
            max={MAX_BLUR}
            fps={fps}
            disabled={disabled}
            onCommit={(blur) => {
              if (blur !== null) edit({ blur });
            }}
          />
          <ValueField
            key={`${clip.id}:radius`}
            label="Corners"
            value={region.radius}
            unit="pixels"
            min={0}
            max={MAX_RADIUS}
            fps={fps}
            disabled={disabled}
            onCommit={(radius) => {
              if (radius !== null) edit({ radius });
            }}
          />
          <ValueField
            key={`${clip.id}:feather`}
            label="Feather"
            value={region.feather}
            unit="pixels"
            min={0}
            max={MAX_FEATHER}
            fps={fps}
            disabled={disabled}
            onCommit={(feather) => {
              if (feather !== null) edit({ feather });
            }}
          />
        </>
      )}
      <ValueField
        key={`${clip.id}:in`}
        label={zoom ? "Zoom in" : "Fade in"}
        value={region.in}
        unit="timecode"
        min={0}
        max={MAX_RAMP}
        fps={fps}
        disabled={disabled}
        tip="How long the effect takes to arrive from the clip's first frame. 0 starts it at full strength."
        onCommit={(frames) => {
          if (frames !== null) edit({ in: frames });
        }}
      />
      <Row label={zoom ? "Zoom out" : "Fade out"}>
        <input
          type="checkbox"
          aria-label={zoom ? "Zoom back out at the end" : "Fade out at the end"}
          checked={region.out > 0}
          disabled={disabled}
          onChange={(event) =>
            edit({
              out: event.target.checked
                ? region.in || Math.round(fps.num / fps.den / 2)
                : 0,
            })
          }
          onKeyDown={(event) => event.stopPropagation()}
        />
      </Row>
      {region.out > 0 && (
        <ValueField
          key={`${clip.id}:out`}
          label={zoom ? "Out length" : "Fade length"}
          value={region.out}
          unit="timecode"
          min={1}
          max={MAX_RAMP}
          fps={fps}
          disabled={disabled}
          tip="How long the effect takes to leave, ending on the clip's last frame."
          onCommit={(frames) => {
            if (frames !== null) edit({ out: frames });
          }}
        />
      )}
      <Row label="Ease">
        <div className="inspector-eases" role="radiogroup" aria-label="Ease">
          {REGION_EASES.map((ease) => (
            <button
              key={ease}
              type="button"
              role="radio"
              aria-checked={region.ease === ease}
              aria-label={EASE_LABELS[ease]}
              title={EASE_LABELS[ease]}
              disabled={disabled}
              onClick={() => {
                if (ease !== region.ease) edit({ ease });
              }}
            >
              <Curve ease={ease} />
            </button>
          ))}
        </div>
      </Row>
      <div className="inspector-region-actions">
        {tools && tools.mode !== "region" && (
          <button type="button" onClick={() => tools.setMode("region")}>
            Aim on the picture
          </button>
        )}
        {!clip.adjustment && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => edit(null, "Remove zoom")}
          >
            Remove zoom
          </button>
        )}
      </div>
    </details>
  );
}
