import { useEffect, useId, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { CaretRight, Power, X } from "@phosphor-icons/react";
import { HF_AUDIO_FX, getAudioFxDef } from "@hyperframes/core/audio-fx";
import type { HfAudioFxParam } from "@hyperframes/core/audio-fx";
import {
  HF_AUDIO_FX_PRESETS,
  HF_AUDIO_FX_PRESET_FAMILIES,
} from "@hyperframes/core/audio-fx-presets";
import { fxInput } from "../../../shared/timeline/fx";
import type { FxInput, FxNode } from "../../../shared/timeline/fx";
import { openContextMenu } from "../../components/ContextMenu";
import type { MenuItem } from "../../components/menu";
import { SelectMenu } from "../../components/SelectMenu";

const GROUPS = ["filter", "dynamics", "nonlinear", "time"] as const;

/** Rows grouped by kind, a separator between kinds. */
function grouped<Item, Key>(
  keys: readonly Key[],
  items: readonly Item[],
  keyOf: (item: Item) => Key,
  row: (item: Item) => MenuItem,
) {
  return keys.flatMap((key, index) => [
    ...(index ? ["separator" as const] : []),
    ...items.filter((item) => keyOf(item) === key).map(row),
  ]);
}

/**
 * An audio effect chain, for a clip or a track. Every change is the whole chain again, as one
 * command and one undo step.
 */
export function FxRack({
  fx,
  disabled = false,
  open: initial,
  onChange,
}: {
  fx: readonly FxNode[];
  disabled?: boolean;
  /** An effect to show open, or "add" to start with the Add effect menu open. */
  open?: string;
  onChange(label: string, next: FxInput[]): void;
}) {
  const [open, setOpen] = useState<string | null>(
    initial === "add" ? null : (initial ?? null),
  );
  const adding = useRef<HTMLButtonElement>(null);
  const inputs = fx.map(fxInput);
  const replace = (
    id: string,
    change: Partial<Pick<FxNode, "enabled" | "params">>,
  ) =>
    inputs.map((node) =>
      "id" in node && node.id === id ? { ...node, ...change } : node,
    );
  const add = (label: string, entry: FxInput) =>
    onChange(label, [...inputs, entry]);
  const effects = () =>
    grouped(
      GROUPS,
      HF_AUDIO_FX,
      (def) => def.group,
      (def) => ({
        label: def.label,
        run: () => add(`Add ${def.label}`, { type: def.id }),
      }),
    );
  // The menu hangs from its button, as the menu key opens a context menu.
  const menu = (
    event: MouseEvent<HTMLButtonElement>,
    label: string,
    items: MenuItem[],
  ) =>
    openContextMenu(
      {
        preventDefault: () => event.preventDefault(),
        button: -1,
        clientX: event.clientX,
        clientY: event.clientY,
      },
      label,
      items,
      event.currentTarget,
    );
  // Opened from an empty strip's Add effect: the menu hangs from this rack's own button.
  useEffect(() => {
    const button = adding.current;
    if (initial !== "add" || !button || button.disabled) return;
    const box = button.getBoundingClientRect();
    openContextMenu(
      {
        preventDefault() {},
        button: -1,
        clientX: box.left,
        clientY: box.bottom,
      },
      "Add effect",
      effects(),
      button,
    );
    // Only when the rack opens.
  }, []);
  return (
    <div className="inspector-fx" aria-label="Effects" role="group">
      {fx.map((node) => {
        const def = getAudioFxDef(node.type)!;
        const name = node.label ?? def.label;
        const expanded = open === node.id;
        return (
          <div
            key={node.id}
            className="inspector-fx-node"
            data-fx={node.id}
            data-bypassed={node.enabled ? undefined : ""}
          >
            <div className="inspector-fx-row">
              <button
                aria-label={`${node.enabled ? "Bypass" : "Turn on"} ${name}`}
                aria-pressed={node.enabled}
                title={node.enabled ? "Bypass" : "Turn on"}
                disabled={disabled}
                onClick={() =>
                  onChange(
                    `${node.enabled ? "Bypass" : "Turn on"} ${name}`,
                    replace(node.id, { enabled: !node.enabled }),
                  )
                }
              >
                <Power size={12} weight={node.enabled ? "bold" : "regular"} />
              </button>
              <button
                className="inspector-fx-name"
                aria-expanded={expanded}
                title={def.description}
                onClick={() => setOpen(expanded ? null : node.id)}
              >
                <CaretRight size={10} aria-hidden />
                {name}
              </button>
              <button
                aria-label={`Remove ${name}`}
                title="Remove"
                disabled={disabled}
                onClick={() =>
                  onChange(
                    `Remove ${name}`,
                    inputs.filter(
                      (entry) => !("id" in entry) || entry.id !== node.id,
                    ),
                  )
                }
              >
                <X size={12} />
              </button>
            </div>
            {expanded &&
              def.params.map((param) => (
                <FxParam
                  key={`${node.id}:${param.key}`}
                  param={param}
                  value={node.params[param.key]!}
                  disabled={disabled}
                  onCommit={(value) =>
                    onChange(
                      param.label === name
                        ? `Edit ${name}`
                        : `Edit ${name} ${param.label.toLowerCase()}`,
                      replace(node.id, {
                        params: { ...node.params, [param.key]: value },
                      }),
                    )
                  }
                />
              ))}
          </div>
        );
      })}
      <div className="inspector-fx-add">
        <button
          ref={adding}
          disabled={disabled}
          onClick={(event) => menu(event, "Add effect", effects())}
        >
          Add effect
        </button>
        <button
          disabled={disabled}
          onClick={(event) =>
            menu(
              event,
              "Add preset",
              grouped(
                HF_AUDIO_FX_PRESET_FAMILIES,
                HF_AUDIO_FX_PRESETS,
                (preset) => preset.family,
                (preset) => ({
                  label: preset.label,
                  run: () => add(`Add ${preset.label}`, { preset: preset.id }),
                }),
              ),
            )
          }
        >
          Add preset
        </button>
      </div>
    </div>
  );
}

/** One knob: a number in the effect's range and unit, or one of its choices. */
function FxParam({
  param,
  value,
  disabled,
  onCommit,
}: {
  param: HfAudioFxParam;
  value: number | string;
  disabled: boolean;
  onCommit(value: number | string): void;
}) {
  const id = useId();
  if (param.kind === "enum")
    return (
      <div className="inspector-field">
        <span className="inspector-label" id={id}>
          {param.label}
        </span>
        <SelectMenu
          label={param.label}
          value={String(value)}
          options={param.options}
          disabled={disabled}
          onChange={onCommit}
        />
      </div>
    );
  const commit = (input: HTMLInputElement) => {
    const next = Number(input.value);
    // Typed numbers only, kept in the effect's range; anything else goes back to the value.
    if (input.value.trim() === "" || !Number.isFinite(next)) {
      input.value = String(value);
      return;
    }
    const clamped = Math.min(param.max, Math.max(param.min, next));
    input.value = String(clamped);
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <div className="inspector-field" title={param.hint}>
      <label htmlFor={id}>{param.label}</label>
      <div className="inspector-fx-number">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          key={value}
          defaultValue={String(value)}
          disabled={disabled}
          onBlur={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(event.currentTarget);
            if (event.key === "Escape")
              event.currentTarget.value = String(value);
          }}
        />
        {param.unit && <span>{param.unit}</span>}
      </div>
    </div>
  );
}
