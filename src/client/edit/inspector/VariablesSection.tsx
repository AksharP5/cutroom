import type { Clip } from "../../../shared/timeline/schema";
import { isEditable, variableDefaultValue } from "../../../shared/variables";
import type {
  CompositionVariable,
  EditableVariable,
  VariableDeclaration,
  VariableValue,
} from "../../../shared/variables";
import { SelectMenu } from "../../components/SelectMenu";
import {
  declareVariable,
  bindVariable,
  makeDefault,
  previewVariable,
  useVariables,
} from "../variables";
import { ColourFields, DraftField, Row } from "./TitleSection";

/**
 * The open composition's variables. Editing a value previews it without touching the source;
 * Set default writes it into the declaration. Shown only when the composition declares some.
 */
export function VariablesSection({ projectId }: { projectId: string }) {
  const state = useVariables((store) => store.state);
  if (!state?.declarations.length) return null;
  return (
    <section className="inspector-section inspector-variables">
      <h3>
        Variables{" "}
        <span className="inspector-count">{state.declarations.length}</span>
      </h3>
      {state.declarations.map((variable) => (
        <VariableRow
          key={variable.id}
          projectId={projectId}
          variable={variable}
          preview={state.preview[variable.id]}
        />
      ))}
    </section>
  );
}

function VariableRow({
  projectId,
  variable,
  preview,
}: {
  projectId: string;
  variable: CompositionVariable;
  preview: VariableValue | undefined;
}) {
  const overridden = preview !== undefined;
  return (
    <div className="inspector-field" data-overridden={overridden || undefined}>
      <span
        className="inspector-label"
        title={overridden ? "Double-click to preview the default" : undefined}
        onDoubleClick={
          overridden
            ? () => void previewVariable(projectId, variable.id, null)
            : undefined
        }
      >
        {variable.label}
      </span>
      <div className="inspector-value">
        {isEditable(variable) ? (
          <VariableControl
            variable={variable}
            value={preview ?? variableDefaultValue(variable)}
            onChange={(value) =>
              void previewVariable(projectId, variable.id, value)
            }
          />
        ) : (
          <DraftField
            label={variable.label}
            className="inspector-variable-text"
            value={
              typeof variable.default === "string"
                ? variable.default
                : variable.default.name
            }
            disabled
            parse={(text) => text}
            onCommit={() => {}}
          />
        )}
        {overridden && (
          <button
            type="button"
            onClick={() => void makeDefault(projectId, variable.id)}
          >
            Set default
          </button>
        )}
      </div>
    </div>
  );
}

function VariableControl({
  variable,
  value,
  onChange,
}: {
  variable: EditableVariable;
  value: VariableValue;
  onChange(value: VariableValue): void;
}) {
  switch (variable.type) {
    case "string":
    case "image":
      return (
        <DraftField
          label={variable.label}
          className="inspector-variable-text"
          value={String(value)}
          disabled={false}
          parse={(text) => text}
          onCommit={onChange}
        />
      );
    case "number":
      return (
        <DraftField
          label={variable.label}
          className="inspector-number"
          value={String(value)}
          disabled={false}
          parse={(text) => {
            const number = Number(text.trim());
            if (!text.trim() || !Number.isFinite(number))
              throw new Error(`Enter a number for ${variable.label}.`);
            return String(number);
          }}
          onCommit={(text) => onChange(Number(text))}
        />
      );
    case "color":
      return (
        <ColourFields
          label={variable.label}
          value={String(value).toLowerCase()}
          disabled={false}
          onCommit={onChange}
        />
      );
    case "boolean":
      return (
        <input
          type="checkbox"
          aria-label={variable.label}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          onKeyDown={(event) => event.stopPropagation()}
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
  }
}

/** A variable id from a clip's: letters, digits, - and _, unused in this composition. */
function freeId(base: string, taken: readonly CompositionVariable[]) {
  const stem =
    base
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^[^A-Za-z_]+/, "")
      .slice(0, 56) || "variable";
  let id = stem;
  for (let n = 2; taken.some((item) => item.id === id); n++)
    id = `${stem}-${n}`;
  return id;
}

/** Binds words or colour to a declared variable, or creates one with the clip's value. */
export function BindVariable({
  projectId,
  clip,
  name,
}: {
  projectId: string;
  clip: Clip;
  name: string;
}) {
  const state = useVariables((store) => store.state);
  if (!state || clip.kind !== "element" || clip.title) return null;
  // One line of plain words: HyperFrames replaces only an element's own text, not its line breaks.
  const plain =
    clip.text !== null &&
    !clip.text.includes("\n") &&
    !clip.sourceRestrictions?.text;
  const words = plain && !clip.variableBindings?.text;
  const colour = clip.style.color;
  if (
    !words &&
    !colour &&
    !clip.variableBindings?.text &&
    !clip.variableBindings?.color
  )
    return null;
  return (["text", "color"] as const).map((to) => {
    const text = to === "text";
    const label = text ? "Words variable" : "Colour variable";
    const current = clip.variableBindings?.[to];
    const available = state.declarations.filter(
      (variable) => variable.type === (text ? "string" : "color"),
    );
    const allowed = text ? words : plain && (!!colour || !!current);
    const create = text ? words : !!colour && !current;
    if (!current && !create && (!allowed || !available.length)) return null;
    const binding = { clipId: clip.id, to };
    return (
      <Row key={to} label={text ? "Words" : "Colour"}>
        <SelectMenu
          label={label}
          value={current ?? ""}
          readOnly={!allowed && !create}
          options={[
            ...(!current ? [{ value: "", label: "Choose variable" }] : []),
            ...(current &&
            !available.some((variable) => variable.id === current)
              ? [{ value: current, label: current }]
              : []),
            ...(allowed
              ? available
              : available.filter(({ id }) => id === current)
            ).map((variable) => ({
              value: variable.id,
              label: `${variable.label} (${variable.id})`,
            })),
            ...(create ? [{ value: "@new", label: "New variable…" }] : []),
          ]}
          onChange={(id) => {
            if (id === "@new") {
              const variable: VariableDeclaration = text
                ? {
                    id: freeId(`${clip.id}-text`, state.declarations),
                    type: "string",
                    label: `${name} text`,
                    default: clip.text ?? "",
                  }
                : {
                    id: freeId(`${clip.id}-color`, state.declarations),
                    type: "color",
                    label: `${name} colour`,
                    default: colour!,
                  };
              void declareVariable(projectId, variable, binding);
            } else if (id) void bindVariable(projectId, id, binding);
          }}
        />
      </Row>
    );
  });
}
