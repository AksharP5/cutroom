import { useEffect, useId, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import { agentProviderSchema } from "../../../shared/agent";
import type { AgentCapabilities, AgentProvider } from "../../../shared/agent";
import { menuStep } from "../menu";
import "../select-menu.css";

export const providerNames = { codex: "Codex", claude: "Claude Code" };

export function selectedModel(
  capabilities: AgentCapabilities | undefined,
  model: string | undefined,
) {
  return capabilities?.models.find((item) =>
    model === undefined ? item.isDefault : item.id === model,
  );
}

const effortLabel = (effort: string) =>
  effort.charAt(0).toUpperCase() + effort.slice(1);

export function ModelMenu({
  catalog,
  provider,
  model,
  effort,
  hasMessages,
  disabled,
  locked,
  pending,
  onModel,
  onEffort,
}: {
  catalog: Partial<Record<AgentProvider, AgentCapabilities>>;
  provider: AgentProvider;
  model?: string;
  effort?: string;
  hasMessages: boolean;
  disabled: boolean;
  locked: boolean;
  pending: boolean;
  onModel(provider: AgentProvider, model: string | null): void;
  onEffort(effort: string | null): void;
}) {
  const id = useId();
  const anchor = `--chat-model-${id.replace(/[^a-zA-Z0-9-]/g, "")}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [focusedModel, setFocusedModel] = useState("");
  const [focusedEffort, setFocusedEffort] = useState<string | null>(
    effort ?? null,
  );
  const current = selectedModel(catalog[provider], model);
  const defaultChoice = !model || current?.isDefault;
  const modelName = current?.name ?? model;
  const shortName = defaultChoice
    ? providerNames[provider]
    : modelName?.replace(/^GPT[- ]/i, "").replace(/^(\d+\.\d+)-/, "$1 ");
  const name = `Model: ${[
    providerNames[provider],
    modelName,
    effort && `${effortLabel(effort)} effort`,
  ]
    .filter(Boolean)
    .join(", ")}`;
  const efforts = catalog[provider]?.available ? (current?.efforts ?? []) : [];
  const effortTabStop =
    focusedEffort === null || efforts.includes(focusedEffort)
      ? focusedEffort
      : (effort ?? null);
  const modelRows = () =>
    Array.from(
      popup.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        [],
    );

  useEffect(() => {
    if (disabled) popup.current?.hidePopover();
  }, [disabled]);

  function show() {
    if (pending) return;
    popup.current?.showPopover();
    search.current = { text: "", at: 0 };
    setFocusedEffort(effort ?? null);
    const rows = modelRows();
    const row =
      rows.find((row) => row.getAttribute("aria-selected") === "true") ??
      rows[0];
    (row ?? popup.current)?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="select-trigger select-label chat-model-trigger"
        style={{ anchorName: anchor }}
        popoverTarget={id}
        aria-controls={id}
        aria-haspopup="dialog"
        aria-label={name}
        aria-expanded={open}
        aria-disabled={pending || undefined}
        title={locked ? "Stop the run first" : name}
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          if (popup.current?.matches(":popover-open")) {
            popup.current.hidePopover();
            trigger.current?.focus();
          } else show();
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          show();
        }}
      >
        <span>
          <span>{shortName}</span>
          {effort && (
            <>
              {" "}
              <em>{effortLabel(effort)}</em>
            </>
          )}
        </span>
        <CaretDown />
      </button>
      <div
        ref={popup}
        id={id}
        tabIndex={-1}
        className="select-menu chat-model-menu"
        style={{ positionAnchor: anchor }}
        popover="auto"
        role="dialog"
        aria-label="Model and effort"
        onToggle={(event) => setOpen(event.newState === "open")}
        onBlur={(event) => {
          if (
            event.relatedTarget &&
            event.relatedTarget !== trigger.current &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            event.currentTarget.hidePopover();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key !== "Escape") return;
          event.preventDefault();
          popup.current?.hidePopover();
          trigger.current?.focus();
        }}
      >
        <div
          role="listbox"
          aria-label="Models"
          onKeyDown={(event) => {
            const rows = modelRows();
            const next = menuStep(
              event,
              rows.map((row) => row.textContent ?? ""),
              rows.findIndex((row) => row === document.activeElement),
              search.current,
            );
            if (next === null) return;
            event.preventDefault();
            rows[next]?.focus({ preventScroll: true });
            rows[next]?.scrollIntoView({ block: "nearest" });
          }}
        >
          {agentProviderSchema.options.map((group) => {
            const capability = catalog[group];
            if (!capability) return null;
            const groupLabel = `${id}-${group}`;
            const rows = [
              { id: null, name: "Default" },
              ...capability.models.filter((item) => !item.isDefault),
            ];
            return (
              <div key={group} role="group" aria-labelledby={groupLabel}>
                <div className="chat-model-label">
                  <span id={groupLabel}>{providerNames[group]}</span>
                  {capability.available &&
                    group !== provider &&
                    hasMessages && <span>Starts a new chat</span>}
                </div>
                {!capability.available && (
                  <p className="chat-model-unavailable">
                    {capability.error ?? "Agent unavailable"}
                  </p>
                )}
                {capability.available &&
                  rows.map((row) => {
                    const key = `${group}:${row.id ?? ""}`;
                    const chosen =
                      provider === group &&
                      (defaultChoice ? row.id === null : row.id === model);
                    return (
                      <button
                        key={key}
                        type="button"
                        role="option"
                        title={row.name}
                        aria-selected={chosen}
                        aria-disabled={pending || undefined}
                        tabIndex={focusedModel === key ? 0 : -1}
                        onFocus={() => setFocusedModel(key)}
                        onClick={() => {
                          if (pending || chosen) return;
                          if (group !== provider) popup.current?.hidePopover();
                          onModel(group, row.id);
                        }}
                      >
                        <span>{row.name}</span>
                        {chosen && <Check weight="bold" />}
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </div>
        {efforts.length > 0 && (
          <>
            <hr />
            <div className="chat-model-label" id={`${id}-effort`}>
              Effort
            </div>
            <div
              className="chat-efforts"
              role="radiogroup"
              aria-labelledby={`${id}-effort`}
              style={{
                gridTemplateColumns: `repeat(${Math.min(6, efforts.length + 1)}, minmax(0, 1fr))`,
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                event.preventDefault();
                const cells = Array.from(
                  event.currentTarget.querySelectorAll("button"),
                );
                const index = cells.findIndex(
                  (cell) => cell === document.activeElement,
                );
                const step = event.key === "ArrowRight" ? 1 : -1;
                cells[(index + step + cells.length) % cells.length]?.focus();
              }}
            >
              {[null, ...efforts].map((value) => {
                const label = value === null ? "Auto" : effortLabel(value);
                return (
                  <button
                    key={value ?? ""}
                    type="button"
                    role="radio"
                    aria-checked={value === (effort ?? null)}
                    aria-disabled={pending || undefined}
                    tabIndex={value === effortTabStop ? 0 : -1}
                    title={label}
                    onFocus={() => setFocusedEffort(value)}
                    onClick={() => {
                      if (!pending && value !== (effort ?? null))
                        onEffort(value);
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
