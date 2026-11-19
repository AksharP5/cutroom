import { normalizeHfColorGrading } from "@hyperframes/core/color-grading";
import {
  COLOR_GRADING_ADVANCED_LIMITS,
  COLOR_GRADING_MAX_SECONDARIES,
} from "@hyperframes/parsers/color-grading-contract";
import { Plus, Trash } from "@phosphor-icons/react";
import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { editGrade } from "../../../shared/timeline/grade";
import type { Grade } from "../../../shared/timeline/grade";
import type { Clip, Fps } from "../../../shared/timeline/schema";
import { SelectMenu } from "../../components/SelectMenu";
import {
  cancelGradePreview,
  commitGradePreview,
  previewGrade,
} from "../preview";
import { editTimeline } from "../timeline";
import { FieldRow, ValueCell, ValueField } from "./ValueField";

type Secondary = NonNullable<Grade["secondaries"]>[number];
type Change = (secondary: Secondary) => Secondary;
type Range = { min: number; max: number };

const QUALIFIERS = ["saturation", "luma"] as const;
const {
  hueDegrees,
  secondaryHueCombinedMax,
  secondaryHueRange,
  secondaryHueShift,
  secondaryHueSoftness,
  secondarySoftRangeSoftness,
  signedUnit,
  unit,
} = COLOR_GRADING_ADVANCED_LIMITS;
const CORRECTIONS = [
  ["hueShift", "Hue shift", "degrees", secondaryHueShift],
  ["saturation", "Saturation", "percent", signedUnit],
  ["luma", "Luma", "percent", signedUnit],
  ["temperature", "Temperature", "percent", signedUnit],
  ["tint", "Tint", "percent", signedUnit],
] as const;

// GradeSchema stores four decimal places. An authored low bound must stay below the high bound.
const RANGE_STEP = 0.0001;
const stored = (value: number) => Number(value.toFixed(4));

export function HslSecondaries({
  projectId,
  clip,
  fps,
  disabled,
}: {
  projectId: string;
  clip: Clip;
  fps: Fps;
  disabled: boolean;
}) {
  const headingId = useId();
  const [selected, setSelected] = useState(0);
  const secondaries = clip.grade?.secondaries ?? [];
  const index = Math.max(0, Math.min(selected, secondaries.length - 1));
  const source = secondaries[index];
  const secondary = source
    ? normalizeHfColorGrading({ secondaries: [source] })?.secondaries[0]
    : undefined;
  const version = JSON.stringify(secondaries);
  const startedOn = useRef(new Map<string, string>());
  const replace = (entries: Secondary[], change: Change) =>
    entries.map((entry, at) => (at === index ? change(entry) : entry));
  const cancel = (label: string) => {
    startedOn.current.delete(label);
    cancelGradePreview(clip.id);
  };
  const save = (
    label: string,
    change: (entries: Secondary[]) => Secondary[],
    expected = version,
  ) =>
    editTimeline(projectId, label, (timeline) => {
      const current = timeline.clips.find(({ id }) => id === clip.id);
      if (!current) return [];
      const entries = current.grade?.secondaries ?? [];
      // Secondary slots have no IDs. A changed list may put a different key at this index.
      if (JSON.stringify(entries) !== expected)
        throw new Error("The HSL selections changed. Try the edit again.");
      return [
        {
          type: "setClip",
          clipId: clip.id,
          grade: { secondaries: change(entries) },
        },
      ];
    });

  const field = (
    label: string,
    value: number,
    change: (value: number) => Change,
  ) => ({
    label,
    value,
    fps,
    disabled,
    onStart: () => {
      startedOn.current.set(label, version);
    },
    onCancel: () => cancel(label),
    onPreview(next: number) {
      if (stored(next) === value || startedOn.current.get(label) !== version) {
        cancelGradePreview(clip.id);
        return;
      }
      const edited = editGrade(clip.grade, {
        secondaries: replace(secondaries, change(stored(next))),
      });
      if ("grade" in edited) previewGrade(clip.id, edited.grade);
      else cancelGradePreview(clip.id);
    },
    onCommit(next: number | null) {
      if (next === null || stored(next) === value) {
        cancel(label);
        return;
      }
      const expected = startedOn.current.get(label) ?? version;
      startedOn.current.delete(label);
      void commitGradePreview(() =>
        save(
          `Set ${label.toLowerCase()}`,
          (entries) => replace(entries, change(stored(next))),
          expected,
        ),
      );
    },
  });
  const hueField = (
    key: keyof NonNullable<Secondary["key"]["hue"]>,
    name: string,
    value: number,
    caps: Range,
  ) => ({
    unit: "degrees" as const,
    ...caps,
    ...field(name, value, (next) => (entry) => ({
      ...entry,
      key: { ...entry.key, hue: { ...entry.key.hue, [key]: next } },
    })),
  });

  return (
    <section
      className="inspector-secondaries"
      aria-labelledby={headingId}
      onPointerDownCapture={(event) => {
        const active = document.activeElement;
        if (
          !disabled &&
          event.button === 0 &&
          event.target instanceof Element &&
          event.target.closest("label") &&
          active instanceof HTMLInputElement &&
          event.currentTarget.contains(active)
        ) {
          // A scrub captures its starting grade before the normal focus change.
          // Save any typed value first so the scrub starts on the resulting grade.
          flushSync(() => active.blur());
        }
      }}
    >
      <div className="inspector-secondary-header">
        <h3 id={headingId}>HSL secondary</h3>
        {secondaries.length > 0 && (
          <SelectMenu
            label="HSL selection"
            value={String(index)}
            disabled={disabled}
            options={secondaries.map((_, at) => ({
              value: String(at),
              label: `Selection ${at + 1}`,
            }))}
            onChange={(value) => setSelected(Number(value))}
          />
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="Add secondary"
          title="Add secondary"
          disabled={
            disabled || secondaries.length >= COLOR_GRADING_MAX_SECONDARIES
          }
          onClick={() => {
            void save("Add secondary", (entries) => [
              ...entries,
              { key: {}, correction: {} },
            ]);
            setSelected(secondaries.length);
          }}
        >
          <Plus size={14} aria-hidden />
        </button>
        {secondary && (
          <button
            type="button"
            className="icon-button"
            aria-label="Remove secondary"
            title="Remove secondary"
            disabled={disabled}
            onClick={() => {
              void save("Remove secondary", (entries) =>
                entries.filter((_, at) => at !== index),
              );
              setSelected(Math.max(0, Math.min(index, secondaries.length - 2)));
            }}
          >
            <Trash size={14} aria-hidden />
          </button>
        )}
      </div>
      {secondary && (
        <div key={index}>
          <div className="inspector-secondary-key">
            <FieldRow label="Hue">
              <ValueCell
                axis="Ctr"
                {...hueField("center", "Hue center", secondary.key.hue.center, {
                  min: hueDegrees.min,
                  max: hueDegrees.max - RANGE_STEP,
                })}
              />
              <ValueCell
                axis="Range"
                {...hueField("range", "Hue range", secondary.key.hue.range, {
                  min: secondaryHueRange.min,
                  max: stored(
                    secondaryHueCombinedMax - (source?.key.hue?.softness ?? 0),
                  ),
                })}
              />
              <ValueCell
                axis="Soft"
                {...hueField(
                  "softness",
                  "Hue softness",
                  source?.key.hue?.softness ?? secondary.key.hue.softness,
                  {
                    min: secondaryHueSoftness.min,
                    max: stored(
                      secondaryHueCombinedMax - secondary.key.hue.range,
                    ),
                  },
                )}
              />
            </FieldRow>
            {QUALIFIERS.map((key) => {
              const label = key === "saturation" ? "Saturation" : "Luma";
              const range = secondary.key[key];
              const fields = [
                [
                  "min",
                  "Min",
                  "minimum",
                  {
                    ...unit,
                    max: Math.max(unit.min, stored(range.max - RANGE_STEP)),
                  },
                ],
                [
                  "max",
                  "Max",
                  "maximum",
                  {
                    ...unit,
                    min: Math.min(unit.max, stored(range.min + RANGE_STEP)),
                  },
                ],
                ["softness", "Soft", "softness", secondarySoftRangeSoftness],
              ] as const;
              return (
                <FieldRow key={key} label={label}>
                  {fields.map(([part, axis, suffix, limits]) => (
                    <ValueCell
                      key={part}
                      axis={axis}
                      unit="percent"
                      {...limits}
                      {...field(
                        `${label} ${suffix}`,
                        range[part],
                        (next) => (entry) => ({
                          ...entry,
                          key: {
                            ...entry.key,
                            [key]: { ...entry.key[key], [part]: next },
                          },
                        }),
                      )}
                    />
                  ))}
                </FieldRow>
              );
            })}
          </div>
          <div
            className="inspector-secondary-correction"
            role="group"
            aria-labelledby={`${headingId}-correction`}
          >
            <h4 id={`${headingId}-correction`}>Correction</h4>
            {CORRECTIONS.map(([key, name, unit, limits]) => (
              <ValueField
                key={key}
                unit={unit}
                initial={0}
                {...limits}
                {...field(
                  name,
                  secondary.correction[key],
                  (next) => (entry) => ({
                    ...entry,
                    correction: { ...entry.correction, [key]: next },
                  }),
                )}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
