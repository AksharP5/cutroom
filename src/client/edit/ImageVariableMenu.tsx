import { useMemo } from "react";
import {
  inMediaTrash,
  isFreezeExport,
  localMediaPath,
  mediaKind,
  sourceUrl,
} from "../../shared/media";
import { SelectMenu } from "../components/SelectMenu";
import { useWorkspace } from "../workspace";
import { useVariables } from "./variables";

export function ImageVariableMenu({
  label,
  value,
  onChange,
  composition: relativeTo,
  disabled,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  composition?: string;
  disabled?: boolean;
}) {
  const files = useWorkspace((state) => state.fileChanges);
  const activeComposition = useVariables(
    (store) => store.state?.composition ?? "index.html",
  );
  const composition = relativeTo ?? activeComposition;
  const images = useMemo(
    () =>
      Object.entries(files).flatMap(([path, version]) =>
        version !== null &&
        !inMediaTrash(path) &&
        !isFreezeExport(path) &&
        mediaKind(path)?.kind === "image"
          ? [
              {
                value: sourceUrl(composition, path),
                label: path,
              },
            ]
          : [],
      ),
    [composition, files],
  );
  const path = localMediaPath(composition, value);
  const selected = images.find((image) => image.label === path);
  return (
    <SelectMenu
      label={label}
      disabled={disabled}
      value={selected?.value ?? value}
      options={
        selected
          ? images
          : [{ value, label: value || "Choose image" }, ...images]
      }
      readOnly={images.length === 0}
      onChange={(next) => {
        if (
          next !== selected?.value &&
          images.some((image) => image.value === next)
        )
          onChange(next);
      }}
    />
  );
}
