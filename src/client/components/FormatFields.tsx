import { useId, useState } from "react";
import {
  pictureSizeRule,
  PictureSizeSchema,
  projectRates,
  ProjectRateSchema,
  rateLabel,
  sameRate,
} from "../../shared/projectFormat";
import type { ProjectFormat } from "../../shared/projectFormat";
import { SelectMenu } from "./SelectMenu";

const sizes = [
  { value: "1080p", label: "1080p · 1920 × 1080", width: 1920, height: 1080 },
  { value: "4k", label: "4K · 3840 × 2160", width: 3840, height: 2160 },
  {
    value: "vertical",
    label: "Vertical · 1080 × 1920",
    width: 1080,
    height: 1920,
  },
  { value: "square", label: "Square · 1080 × 1080", width: 1080, height: 1080 },
];
const sizeOptions = [...sizes, { value: "custom", label: "Custom" }];

const rateKey = ({ num, den }: ProjectFormat["fps"]) => `${num}/${den}`;

export function FormatFields({
  format,
  onChange,
  disabled,
}: {
  format: ProjectFormat;
  onChange(format: ProjectFormat): void;
  disabled?: boolean;
}) {
  const id = useId();
  const [custom, setCustom] = useState(false);
  const size = custom
    ? "custom"
    : (sizes.find(
        ({ width, height }) =>
          width === format.width && height === format.height,
      )?.value ?? "custom");
  const known = projectRates.find((rate) => sameRate(rate, format.fps));
  const options = (known ? projectRates : [...projectRates, format.fps]).map(
    (rate) => ({
      value: rateKey(rate),
      label: `${rateLabel(rate)} fps`,
    }),
  );
  const invalidSize =
    size === "custom" && !PictureSizeSchema.safeParse(format).success;
  return (
    <div className="format-fields">
      <div>
        <label htmlFor={`${id}-size`}>Size</label>
        <SelectMenu
          id={`${id}-size`}
          label="Size"
          options={sizeOptions}
          value={size}
          disabled={disabled}
          onChange={(value) => {
            const preset = sizes.find((item) => item.value === value);
            setCustom(!preset);
            if (preset)
              onChange({
                ...format,
                width: preset.width,
                height: preset.height,
              });
          }}
        />
      </div>
      <div>
        <label htmlFor={`${id}-rate`}>Frame rate</label>
        <SelectMenu
          id={`${id}-rate`}
          label="Frame rate"
          options={options}
          value={rateKey(known ?? format.fps)}
          disabled={disabled}
          onChange={(value) => {
            const fps = projectRates.find((rate) => rateKey(rate) === value);
            if (fps) onChange({ ...format, fps });
          }}
        />
      </div>
      {size === "custom" &&
        (["width", "height"] as const).map((field) => (
          <div key={field}>
            <label htmlFor={`${id}-${field}`}>
              {field === "width" ? "Width" : "Height"}
            </label>
            <input
              id={`${id}-${field}`}
              type="number"
              min={240}
              max={7680}
              step={2}
              aria-describedby={invalidSize ? `${id}-size-help` : undefined}
              required
              disabled={disabled}
              value={format[field] || ""}
              onChange={(event) =>
                onChange({ ...format, [field]: Number(event.target.value) })
              }
            />
          </div>
        ))}
      {invalidSize && (
        <p className="field-help" id={`${id}-size-help`}>
          {pictureSizeRule}
        </p>
      )}
      {!ProjectRateSchema.safeParse(known ?? format.fps).success && (
        <p className="field-help">
          Choose a supported frame rate to apply this format.
        </p>
      )}
    </div>
  );
}
