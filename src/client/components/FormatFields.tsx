import { useId, useState } from "react";
import { rateLabel, sameRate } from "../../shared/projectFormat";
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

const rates = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
];
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
  const known = rates.find((rate) => sameRate(rate, format.fps));
  const options = (known ? rates : [...rates, format.fps]).map((rate) => ({
    value: rateKey(rate),
    label: `${rateLabel(rate)} fps`,
  }));
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
            const fps = rates.find((rate) => rateKey(rate) === value);
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
              required
              disabled={disabled}
              value={format[field] || ""}
              onChange={(event) =>
                onChange({ ...format, [field]: Number(event.target.value) })
              }
            />
          </div>
        ))}
    </div>
  );
}
