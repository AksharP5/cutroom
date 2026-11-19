import { ArrowCounterClockwise, CaretRight } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { sourceUrl } from "../../../shared/media";
import {
  editGrade,
  LutInfoSchema,
  writeGrade,
} from "../../../shared/timeline/grade";
import type { Grade, GradeEdit, LutInfo } from "../../../shared/timeline/grade";
import type { Clip, Fps } from "../../../shared/timeline/schema";
import { ApiError, api } from "../../api";
import { SelectMenu } from "../../components/SelectMenu";
import { showToast } from "../../workspace";
import {
  cancelGradePreview,
  commitGradePreview,
  previewGrade,
  useGradeBypass,
} from "../preview";
import { editTimeline } from "../timeline";
import { Row } from "./TitleSection";
import { ValueField } from "./ValueField";
import { CurveEditor, GradeCurvePlot, IDENTITY } from "./CurveEditor";
import type { CurveChannel, CurvePoint } from "./CurveEditor";
import { ColourWheel } from "./ColourWheel";
import type { WheelEdit, WheelRange } from "./ColourWheel";

const WHEELS = {
  shadows: "Shadows",
  midtones: "Midtones",
  highlights: "Highlights",
} satisfies Record<WheelRange, string>;

type GradeCurve = readonly (readonly [number, number])[];
type HueCurve = keyof NonNullable<Grade["hueCurves"]>;
const HUE_CURVES = {
  hueVsHue: { label: "Hue vs hue", range: 180 },
  hueVsSaturation: { label: "Hue vs saturation", range: 1 },
  hueVsLuma: { label: "Hue vs luma", range: 1 },
} satisfies Record<HueCurve, { label: string; range: number }>;
const NEUTRAL_HUE: CurvePoint[] = [
  [0, 0],
  [120, 0],
  [240, 0],
];

type AdjustKey = keyof NonNullable<Grade["adjust"]>;

/**
 * Basic correction, in Lumetri's order and scale: -100 to 100 around 0, saturation 0 to 200 around
 * 100, exposure in stops. The grade stores -1 to 1 (exposure -2 to 2), so a shown value is
 * `neutral + stored * scale`.
 */
const BASIC: readonly {
  key: AdjustKey;
  label: string;
  tip: string;
  scale: number;
  neutral: number;
  limit: number;
}[] = [
  {
    key: "temperature",
    label: "Temperature",
    tip: "Positive is warmer, negative cooler.",
    scale: 100,
    neutral: 0,
    limit: 1,
  },
  {
    key: "tint",
    label: "Tint",
    tip: "Positive is magenta, negative green.",
    scale: 100,
    neutral: 0,
    limit: 1,
  },
  {
    key: "exposure",
    label: "Exposure",
    tip: "Stops of light: 1 doubles it.",
    scale: 1,
    neutral: 0,
    limit: 2,
  },
  {
    key: "contrast",
    label: "Contrast",
    tip: "Spread about mid grey.",
    scale: 100,
    neutral: 0,
    limit: 1,
  },
  {
    key: "highlights",
    label: "Highlights",
    tip: "Bright tones: negative recovers them.",
    scale: 100,
    neutral: 0,
    limit: 1,
  },
  {
    key: "shadows",
    label: "Shadows",
    tip: "Dark tones: positive lifts them.",
    scale: 100,
    neutral: 0,
    limit: 1,
  },
  {
    key: "whites",
    label: "Whites",
    tip: "The white point.",
    scale: 100,
    neutral: 0,
    limit: 1,
  },
  {
    key: "blacks",
    label: "Blacks",
    tip: "The black point: positive crushes, negative lifts.",
    scale: 100,
    neutral: 0,
    limit: 1,
  },
  {
    key: "saturation",
    label: "Saturation",
    tip: "100 is unchanged, 0 black and white.",
    scale: 100,
    neutral: 100,
    limit: 1,
  },
  {
    key: "vibrance",
    label: "Vibrance",
    tip: "Saturation that spares skin and colour already strong.",
    scale: 100,
    neutral: 0,
    limit: 1,
  },
];

const SLIDER_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
/** How long the keys rest before a run of slider steps saves. */
const KEY_PAUSE = 400;
const NONE = "";
const IMPORT = "\u0000import";

/** The project's LUTs, read when the section opens and again after an import. */
function useLuts(projectId: string, open: boolean) {
  const [luts, setLuts] = useState<LutInfo[] | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    api(
      `/projects/${encodeURIComponent(projectId)}/luts`,
      z.object({ luts: z.array(LutInfoSchema) }),
      { signal: controller.signal },
    ).then(
      ({ luts }) => setLuts(luts),
      (error: unknown) => {
        if (!controller.signal.aborted)
          showToast(
            error instanceof Error ? error.message : "The LUTs did not load.",
          );
      },
    );
    return () => controller.abort();
  }, [projectId, open, version]);
  return { luts, reload: () => setVersion((value) => value + 1) };
}

/**
 * A slider beside a basic control's value. It follows the pointer and drafts each step into the
 * viewer, and saves once when it lets go; a double-click puts the control back to neutral.
 */
function GradeSlider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onPreview,
  onCommit,
  onReset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onPreview(value: number): void;
  onCommit(value: number): void;
  onReset(): void;
}) {
  // The slider shows its own value until the saved one catches up, so a held arrow key keeps
  // stepping from where it is rather than from the value before the last save.
  const [live, setLive] = useState<number | null>(null);
  // Key and pointer handlers read the latest step, which a render may not have caught up with.
  const latest = useRef<number | null>(null);
  const saved = useRef<number | null>(null);
  // Saves land in order; an earlier one arriving between key presses must not move the slider.
  useEffect(() => {
    if (latest.current === null || value !== latest.current) return;
    setLive(null);
    latest.current = null;
    saved.current = null;
  }, [value]);
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pause.current), []);
  const settle = () => {
    clearTimeout(pause.current);
    const next = latest.current;
    if (next === null || next === value || next === saved.current) return;
    saved.current = next;
    onCommit(next);
  };
  return (
    <input
      type="range"
      className="inspector-slider"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={live ?? value}
      disabled={disabled}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        latest.current = next;
        setLive(next);
        onPreview(next);
      }}
      onPointerUp={(event) => {
        settle();
        // A drag leaves the arrow keys to the playhead; keyboard focus stays for keyboard users.
        event.currentTarget.blur();
      }}
      // A run of key presses saves once, when the keys pause.
      onKeyUp={() => {
        clearTimeout(pause.current);
        pause.current = setTimeout(settle, KEY_PAUSE);
      }}
      onBlur={settle}
      // The slider's own keys stay with it; Shift+D and the editor's other keys pass through.
      onKeyDown={(event) => {
        if (SLIDER_KEYS.has(event.key) && !event.ctrlKey && !event.altKey)
          event.stopPropagation();
      }}
      onDoubleClick={onReset}
    />
  );
}

type Props = {
  projectId: string;
  composition: string;
  clip: Clip;
  fps: Fps;
  disabled: boolean;
  open: boolean;
  visible: boolean;
  onToggle(open: boolean): void;
};

/**
 * A video or image clip's grade. Each control drafts into the viewer while it is dragged or
 * stepped, and saves once, as one undo step, when it lets go.
 */
export function ColorSection({
  projectId,
  composition,
  clip,
  fps,
  disabled,
  open,
  visible,
  onToggle,
}: Props) {
  const grade = clip.grade;
  const restriction = clip.sourceRestrictions?.grade;
  const locked = disabled || !!restriction;
  const bypass = useGradeBypass((state) => state.bypass);
  const { luts, reload } = useLuts(projectId, open);
  const [channel, setChannel] = useState<CurveChannel>("master");
  const [wheel, setWheel] = useState<WheelRange>("midtones");
  const [hueCurve, setHueCurve] = useState<HueCurve>("hueVsHue");
  const hue = HUE_CURVES[hueCurve];
  const file = useRef<HTMLInputElement>(null);

  const save = (label: string, change: GradeEdit | null) =>
    editTimeline(projectId, label, () => [
      { type: "setClip", clipId: clip.id, grade: change },
    ]);
  const draft = (change: GradeEdit) => {
    const next = editGrade(grade, change);
    if ("grade" in next) previewGrade(clip.id, next.grade);
  };
  const commit = (label: string, change: GradeEdit) =>
    void commitGradePreview(() => save(label, change));
  const wheelChange = (base: Grade | null, change: WheelEdit): GradeEdit => ({
    wheels: { [wheel]: { ...base?.wheels?.[wheel], ...change } },
  });

  const hueChange = (points: CurvePoint[]): GradeEdit => ({
    hueCurves: {
      [hueCurve]: points.map(([input, output]) => [
        input * 360,
        (2 * output - 1) * hue.range,
      ]),
    },
  });

  const saveCurve = (
    label: string,
    change: GradeEdit,
    read: (value: Grade | null) => GradeCurve | undefined,
  ) =>
    void commitGradePreview(() =>
      editTimeline(projectId, label, (timeline) => {
        const current = timeline.clips.find(({ id }) => id === clip.id);
        if (
          !current ||
          JSON.stringify(read(current.grade)) !== JSON.stringify(read(grade))
        )
          return [];
        return [{ type: "setClip", clipId: clip.id, grade: change }];
      }),
    );
  const lutPath = (src: string) =>
    luts?.find((lut) => sourceUrl(composition, lut.path) === src)?.path ?? src;
  const current = grade?.lut ? lutPath(grade.lut.src) : NONE;
  const chooseLut = (path: string) => {
    if (path === IMPORT) {
      file.current?.click();
      return;
    }
    void save(
      path ? "Set look" : "Remove look",
      path
        ? {
            lut: {
              src: sourceUrl(composition, path),
              intensity: grade?.lut?.intensity ?? 1,
            },
          }
        : { lut: null },
    );
  };
  const importLut = async (chosen: File) => {
    const body = new FormData();
    body.append("file", chosen);
    const response = await fetch(
      `/api/cutroom/projects/${encodeURIComponent(projectId)}/luts`,
      { method: "POST", body },
    );
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new ApiError(
        response.status,
        z.object({ error: z.string() }).safeParse(value).data?.error ??
          `The LUT did not import (${response.status}).`,
      );
    const lut = LutInfoSchema.parse(value);
    reload();
    await save("Set look", {
      lut: { src: sourceUrl(composition, lut.path), intensity: 1 },
    });
  };

  return (
    <details
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="inspector-section inspector-color"
    >
      <summary>
        <CaretRight size={10} aria-hidden />
        Colour
        {bypass && <span className="inspector-color-bypass">Bypassed</span>}
      </summary>
      <button
        type="button"
        className="inspector-section-reset"
        aria-label="Reset grade"
        title="Reset grade. Every control goes back to neutral."
        disabled={!grade || locked}
        onClick={() => void save("Reset grade", null)}
      >
        <ArrowCounterClockwise size={12} aria-hidden />
      </button>
      {restriction && <p className="inspector-color-note">{restriction}</p>}
      <Row label="Look">
        <SelectMenu
          label="Look"
          value={current}
          disabled={locked}
          options={[
            { value: NONE, label: "None" },
            ...(luts ?? []).map((lut) => ({
              value: lut.path,
              label: lut.title ?? lut.path.split("/").at(-1)!,
            })),
            ...(grade?.lut && !luts?.some((lut) => lut.path === current)
              ? [{ value: current, label: current.split("/").at(-1)! }]
              : []),
            { value: IMPORT, label: "Import .cube…" },
          ]}
          onChange={chooseLut}
        />
        <input
          ref={file}
          type="file"
          accept=".cube"
          hidden
          onChange={(event) => {
            const chosen = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (chosen)
              importLut(chosen).catch((error: unknown) =>
                showToast(
                  error instanceof Error
                    ? error.message
                    : "The LUT did not import.",
                ),
              );
          }}
        />
      </Row>
      {grade?.lut && (
        <ValueField
          key={`${clip.id}:look`}
          label="Amount"
          value={grade.lut.intensity ?? 1}
          initial={1}
          unit="percent"
          max={1}
          fps={fps}
          disabled={locked}
          tip="How much of the look shows. Double-click the label for all of it."
          onReset={() =>
            void save("Set look amount", {
              lut: { ...grade.lut!, intensity: 1 },
            })
          }
          onPreview={(intensity) =>
            draft({ lut: { ...grade.lut!, intensity } })
          }
          onCancel={() => cancelGradePreview(clip.id)}
          onCommit={(intensity) => {
            if (intensity !== null)
              commit("Set look amount", {
                lut: { ...grade.lut!, intensity },
              });
          }}
        />
      )}
      {BASIC.map(({ key, label, tip, scale, neutral, limit }) => {
        const stored = grade?.adjust?.[key] ?? 0;
        const shown = (value: number) =>
          Number((neutral + value * scale).toFixed(2));
        const stores = (value: number) =>
          Math.min(limit, Math.max(-limit, (value - neutral) / scale));
        const change = (value: number): GradeEdit => ({
          adjust: { [key]: stores(value) },
        });
        return (
          <ValueField
            key={`${clip.id}:${key}`}
            label={label}
            value={shown(stored)}
            initial={neutral}
            unit="number"
            min={shown(-limit)}
            max={shown(limit)}
            fps={fps}
            disabled={locked}
            tip={`${tip} Drag the label or use Up/Down, Shift for 10. Double-click the label to reset.`}
            before={
              <GradeSlider
                label={label}
                value={shown(stored)}
                min={shown(-limit)}
                max={shown(limit)}
                step={scale === 1 ? 0.01 : 1}
                disabled={locked}
                onPreview={(value) => draft(change(value))}
                onCommit={(value) =>
                  commit(`Set ${label.toLowerCase()}`, change(value))
                }
                onReset={() =>
                  void save(`Reset ${label.toLowerCase()}`, {
                    adjust: { [key]: 0 },
                  })
                }
              />
            }
            onReset={() =>
              void save(`Reset ${label.toLowerCase()}`, {
                adjust: { [key]: 0 },
              })
            }
            onPreview={(value) => draft(change(value))}
            onCancel={() => cancelGradePreview(clip.id)}
            onCommit={(value) => {
              if (value !== null)
                commit(`Set ${label.toLowerCase()}`, change(value));
            }}
          />
        );
      })}
      {open && visible && (
        <ColourWheel
          key={`${clip.id}:${wheel}`}
          label={WHEELS[wheel]}
          value={grade?.wheels?.[wheel]}
          fps={fps}
          disabled={locked}
          selector={
            <SelectMenu
              label="Colour wheels"
              value={wheel}
              disabled={locked}
              options={Object.entries(WHEELS).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(value) => {
                if (
                  value === "shadows" ||
                  value === "midtones" ||
                  value === "highlights"
                )
                  setWheel(value);
              }}
            />
          }
          onPreview={(value) => draft(wheelChange(grade, value))}
          onCommit={(value) =>
            void commitGradePreview(() =>
              editTimeline(projectId, `Set ${wheel} wheel`, (timeline) => {
                const current = timeline.clips.find(({ id }) => id === clip.id);
                if (!current) return [];
                const change = wheelChange(current.grade, value);
                const edited = editGrade(current.grade, change);
                if (
                  "grade" in edited &&
                  writeGrade(edited.grade) === writeGrade(current.grade)
                )
                  return [];
                return [{ type: "setClip", clipId: clip.id, grade: change }];
              }),
            )
          }
          onReset={() =>
            void save(`Reset ${wheel} wheel`, { wheels: { [wheel]: {} } })
          }
          onCancel={() => cancelGradePreview(clip.id)}
        />
      )}
      <Row label="Curves">
        <button
          type="button"
          className="inspector-curve-reset"
          disabled={locked || !grade?.curves?.[channel]}
          onClick={() =>
            void save(`Reset ${channel} curve`, {
              curves: { [channel]: null },
            })
          }
        >
          Reset
        </button>
      </Row>
      {open && visible && (
        <>
          <CurveEditor
            key={`${clip.id}:${channel}:${locked}`}
            channel={channel}
            points={grade?.curves?.[channel] ?? IDENTITY}
            disabled={locked}
            onChannel={setChannel}
            onPreview={(points) => draft({ curves: { [channel]: points } })}
            onCancel={() => cancelGradePreview(clip.id)}
            onCommit={(points) =>
              saveCurve(
                `Set ${channel} curve`,
                { curves: { [channel]: points } },
                (value) => value?.curves?.[channel],
              )
            }
          />
          <div className="inspector-wheel-header">
            <SelectMenu
              label="Hue curves"
              value={hueCurve}
              disabled={locked}
              options={Object.entries(HUE_CURVES).map(([value, { label }]) => ({
                value,
                label,
              }))}
              onChange={(value) => {
                if (
                  value === "hueVsHue" ||
                  value === "hueVsSaturation" ||
                  value === "hueVsLuma"
                )
                  setHueCurve(value);
              }}
            />
            <button
              type="button"
              className="inspector-curve-reset"
              aria-label={`Reset ${hue.label} curve`}
              disabled={locked || !grade?.hueCurves?.[hueCurve]}
              onClick={() =>
                void save(`Reset ${hue.label} curve`, {
                  hueCurves: { [hueCurve]: null },
                })
              }
            >
              Reset
            </button>
          </div>
          <div className="inspector-curve">
            <GradeCurvePlot
              key={`${clip.id}:${hueCurve}:${locked}`}
              label={hue.label}
              points={(grade?.hueCurves?.[hueCurve] ?? NEUTRAL_HUE)
                .map(
                  ([input, output]) =>
                    [input / 360, 0.5 + output / (2 * hue.range)] as const,
                )
                .sort(([a], [b]) => a - b)}
              hueRange={hue.range}
              disabled={locked}
              onPreview={(points) => draft(hueChange(points))}
              onCommit={(points) =>
                saveCurve(
                  `Set ${hue.label} curve`,
                  hueChange(points),
                  (value) => value?.hueCurves?.[hueCurve],
                )
              }
              onCancel={() => cancelGradePreview(clip.id)}
            />
            <div className="inspector-hue-spectrum" aria-hidden />
          </div>
        </>
      )}
    </details>
  );
}
