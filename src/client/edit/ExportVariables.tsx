import { isEditable, variableDefaultValue } from "../../shared/variables";
import type {
  EditableVariable,
  VariableValue,
  VariableValues,
} from "../../shared/variables";
import { SelectMenu } from "../components/SelectMenu";
import { ImageVariableMenu } from "./ImageVariableMenu";
import { useVariables } from "./variables";

/**
 * What the dialog sends as `variables`: the typed values that differ from their defaults. Numbers
 * are typed as text, so a value that is not one throws with the variable's name.
 */
export function exportVariables(drafts: Record<string, string | boolean>) {
  const declarations = useVariables.getState().state?.declarations ?? [];
  const values: VariableValues = {};
  for (const variable of declarations.filter(isEditable)) {
    const draft = drafts[variable.id];
    if (draft === undefined) continue;
    let value: VariableValue = draft;
    if (variable.type === "number") {
      value = Number(String(draft).trim());
      if (!String(draft).trim() || !Number.isFinite(value))
        throw new Error(`Enter a number for ${variable.label}.`);
    }
    if (value !== variableDefaultValue(variable)) values[variable.id] = value;
  }
  return values;
}

/** The viewer's overrides as the dialog's starting values. */
export const previewDrafts = (): Record<string, string | boolean> =>
  Object.fromEntries(
    Object.entries(useVariables.getState().state?.preview ?? {}).map(
      ([id, value]) => [id, typeof value === "number" ? String(value) : value],
    ),
  );

/** One field per variable the export can override, as `hyperframes render --variables` does. */
export function ExportVariables({
  drafts,
  onChange,
}: {
  drafts: Record<string, string | boolean>;
  onChange(id: string, value: string | boolean): void;
}) {
  const declarations = useVariables((store) => store.state?.declarations);
  const variables = declarations?.filter(isEditable) ?? [];
  if (!variables.length) return null;
  return (
    <fieldset className="export-variables">
      <legend>Variables</legend>
      {variables.map((variable) => (
        <label
          key={variable.id}
          className={
            variable.type === "boolean" ? "export-check" : "export-field"
          }
        >
          {variable.type !== "boolean" && variable.label}
          <Field
            variable={variable}
            value={
              drafts[variable.id] ?? fieldValue(variableDefaultValue(variable))
            }
            onChange={(value) => onChange(variable.id, value)}
          />
          {variable.type === "boolean" && variable.label}
        </label>
      ))}
    </fieldset>
  );
}

const fieldValue = (value: VariableValue) =>
  typeof value === "number" ? String(value) : value;

function Field({
  variable,
  value,
  onChange,
}: {
  variable: EditableVariable;
  value: string | boolean;
  onChange(value: string | boolean): void;
}) {
  switch (variable.type) {
    case "image":
      return (
        <ImageVariableMenu
          label={variable.label}
          value={String(value)}
          onChange={onChange}
        />
      );
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      );
    case "enum":
      return (
        <SelectMenu
          label={variable.label}
          value={String(value)}
          options={variable.options}
          onChange={onChange}
        />
      );
    case "color":
      return (
        <input
          type="color"
          className="export-swatch"
          value={String(value).toLowerCase()}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    default:
      return (
        <input
          value={String(value)}
          inputMode={variable.type === "number" ? "decimal" : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}
