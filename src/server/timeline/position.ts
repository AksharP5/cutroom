import type { Clip } from "../../shared/timeline/schema";

type Axis = "x" | "y";
const numeric = (value: string | undefined) => {
  const number = Number.parseFloat(value ?? "");
  return Number.isFinite(number) ? number : 0;
};
const hasPosition = (attrs: Record<string, string>) =>
  attrs["data-hf-edit-base-x"] !== undefined ||
  attrs["data-hf-edit-base-y"] !== undefined;

/** The runtime applies both axes whenever either baseline exists. */
export function readPosition(attrs: Record<string, string>, axis: Axis) {
  if (!hasPosition(attrs)) return null;
  const offset = Number(
    (
      numeric(attrs[`data-${axis}`]) -
      numeric(attrs[`data-hf-edit-base-${axis}`])
    ).toFixed(6),
  );
  return offset === 0 ? null : offset;
}

/** Capture both baselines so editing one axis never turns the other's authored value into an offset. */
export function positionAttributes(
  attrs: Record<string, string>,
  position: Pick<Clip, "x" | "y">,
): [string, string | null][] {
  const active = position.x !== null || position.y !== null;
  const captured = hasPosition(attrs);
  return (["x", "y"] as const).flatMap((axis): [string, string | null][] => {
    const attribute = `data-${axis}`;
    const baselineAttribute = `data-hf-edit-base-${axis}`;
    const baseline = numeric(
      captured ? attrs[baselineAttribute] : attrs[attribute],
    );
    return [
      [
        attribute,
        active
          ? String(Number((baseline + (position[axis] ?? 0)).toFixed(6)))
          : baseline
            ? String(baseline)
            : null,
      ],
      [baselineAttribute, active ? String(baseline) : null],
    ];
  });
}
