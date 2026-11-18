import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Clip } from "../../../shared/timeline/schema";
import {
  localMediaPath,
  previewMediaPath,
  sourcePath,
} from "../../../shared/media";
import {
  isEditable,
  variableDefaultValue,
  VariableDeclarationSchema,
  SceneVariablesSchema,
  VariableIdSchema,
} from "../../../shared/variables";
import type {
  CompositionVariable,
  EditableVariable,
  SceneVariables,
  VariableDeclaration,
  VariableValue,
} from "../../../shared/variables";
import { SelectMenu } from "../../components/SelectMenu";
import { api, json, subscribeProjectEvents } from "../../api";
import { showToast, useWorkspace } from "../../workspace";
import { useCode } from "../code/code";
import { editCompositionSource } from "../timeline";
import { ImageVariableMenu } from "../ImageVariableMenu";
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

const SceneFileChangeSchema = z.object({ path: z.string() });

export function SceneVariablesSection({
  projectId,
  composition,
  clipId,
  revision,
  disabled,
}: {
  projectId: string;
  composition: string;
  clipId: string;
  revision: string;
  disabled: boolean;
}) {
  const [snapshot, setSnapshot] = useState<SceneVariables | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [generation, setGeneration] = useState(0);
  const writing = useRef(false);
  const path = `/projects/${encodeURIComponent(projectId)}/variables/instance`;
  const sourceBusy = useCode(
    (state) =>
      state.projectId === projectId &&
      (state.file?.path === composition ||
        state.file?.path === snapshot?.scene) &&
      (state.edited || state.saving),
  );
  useEffect(() => {
    const closing = new AbortController();
    const query = new URLSearchParams({ composition, clipId });
    void api(`${path}?${query}`, SceneVariablesSchema, {
      signal: closing.signal,
    })
      .then((state) => {
        if (closing.signal.aborted) return;
        setSnapshot(state);
        setError("");
      })
      .catch((error: unknown) => {
        if (closing.signal.aborted) return;
        setSnapshot(null);
        setError(error instanceof Error ? error.message : String(error));
      });
    return () => closing.abort();
  }, [clipId, composition, path, revision, generation]);

  const scene = snapshot?.scene;
  useEffect(() => {
    if (!scene) return;
    return subscribeProjectEvents(projectId, "file-change", (event) => {
      const change = SceneFileChangeSchema.safeParse(JSON.parse(event.data));
      if (change.data?.path === scene) setGeneration((value) => value + 1);
    });
  }, [projectId, scene]);

  const blocked = disabled || !!snapshot?.locked || sourceBusy || saving;
  const save = async (id: string, value: VariableValue | null) => {
    if (!snapshot || blocked || writing.current) return;
    writing.current = true;
    setSaving(true);
    try {
      const next = await editCompositionSource(projectId, composition, () => {
        const code = useCode.getState();
        if (
          code.projectId === projectId &&
          (code.file?.path === composition ||
            code.file?.path === snapshot.scene) &&
          (code.edited || code.saving)
        )
          throw new Error(
            "Save or discard Source changes to edit these values.",
          );
        return api(
          path,
          SceneVariablesSchema,
          json("PUT", {
            composition,
            clipId,
            id,
            value,
            expectedVersion: snapshot.version,
          }),
        );
      });
      setSnapshot(next);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
      setGeneration((value) => value + 1);
    } finally {
      writing.current = false;
      setSaving(false);
    }
  };
  const fields = snapshot?.declarations.filter(
    (variable): variable is EditableVariable =>
      isEditable(variable) && VariableIdSchema.safeParse(variable.id).success,
  );
  if (!error && !fields?.length) return null;
  return (
    <section
      className="inspector-section inspector-variables"
      aria-label="Scene variables"
    >
      <h3>Scene variables</h3>
      {error && (
        <p className="inspector-warning" role="status">
          {error}
        </p>
      )}
      {sourceBusy && (
        <p className="inspector-warning" role="status">
          Save or discard Source changes to edit these values.
        </p>
      )}
      {snapshot &&
        fields?.map((variable) => {
          const value = snapshot.values[variable.id];
          const overridden = Object.hasOwn(snapshot.values, variable.id);
          return (
            <div
              key={variable.id}
              className="inspector-field"
              data-overridden={overridden || undefined}
            >
              <span className="inspector-label">{variable.label}</span>
              <div className="inspector-value">
                <VariableControl
                  variable={variable}
                  value={value ?? variableDefaultValue(variable)}
                  imageComposition="index.html"
                  disabled={blocked}
                  onChange={(next) => void save(variable.id, next)}
                />
                {overridden && (
                  <button
                    type="button"
                    aria-label={`Reset ${variable.label}`}
                    title="Inherit the scene default"
                    disabled={blocked}
                    onClick={() => void save(variable.id, null)}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          );
        })}
    </section>
  );
}

function VariableControl({
  variable,
  value,
  onChange,
  disabled = false,
  imageComposition,
}: {
  variable: EditableVariable;
  value: VariableValue;
  onChange(value: VariableValue): void;
  disabled?: boolean;
  imageComposition?: string;
}) {
  switch (variable.type) {
    case "image":
      return (
        <ImageVariableMenu
          label={variable.label}
          value={String(value)}
          onChange={onChange}
          composition={imageComposition}
          disabled={disabled}
        />
      );
    case "string":
      return (
        <DraftField
          label={variable.label}
          className="inspector-variable-text"
          value={String(value)}
          disabled={disabled}
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
          disabled={disabled}
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
          disabled={disabled}
          onCommit={onChange}
        />
      );
    case "boolean":
      return (
        <input
          type="checkbox"
          aria-label={variable.label}
          checked={value === true}
          disabled={disabled}
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
          disabled={disabled}
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

export function BindImageVariable({
  projectId,
  clip,
  name,
  disabled,
}: {
  projectId: string;
  clip: Clip;
  name: string;
  disabled: boolean;
}) {
  const state = useVariables((store) => store.state);
  const files = useWorkspace((store) => store.fileChanges);
  if (!state || clip.sourceRestrictions?.imageVariable) return null;
  const current = clip.variableBindings?.image;
  const options = state.declarations
    .filter(({ type }) => type === "image")
    .map(({ id, label }) => ({ value: id, label: `${label} (${id})` }));
  const src = clip.src;
  const local = src && localMediaPath(state.composition, src);
  const resolved = src && previewMediaPath(state.composition, src, files);
  const value =
    src && resolved && resolved !== local && !/[?#]/.test(src)
      ? sourcePath(state.composition, resolved)
          .split("/")
          .map(encodeURIComponent)
          .join("/")
      : src;
  const declaration = VariableDeclarationSchema.safeParse({
    type: "image",
    id: freeId(`${clip.id}-image`, state.declarations),
    label: `${name.slice(0, 114)} image`,
    default: value,
  });
  if (!current && !declaration.success && !options.length) return null;
  if (!current || !options.some(({ value }) => value === current))
    options.unshift({
      value: current ?? "",
      label: current ?? "Choose variable",
    });
  if (!current && declaration.success)
    options.push({ value: "@new", label: "New variable…" });
  const bind = { clipId: clip.id, to: "image" } as const;
  return (
    <section className="inspector-section">
      <h3>Image</h3>
      <Row label="Source">
        <SelectMenu
          label="Image variable"
          value={current ?? ""}
          options={options}
          disabled={disabled}
          onChange={(id) => {
            if (id === "@new" && declaration.success)
              void declareVariable(projectId, declaration.data, bind);
            else if (id && id !== current)
              void bindVariable(projectId, id, bind);
          }}
        />
      </Row>
    </section>
  );
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
