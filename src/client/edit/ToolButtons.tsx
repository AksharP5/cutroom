import { Fragment, useEffect, useRef, useState } from "react";
import {
  ChatCircle,
  Cursor,
  Knife,
  PencilSimple,
  SplitHorizontal,
} from "@phosphor-icons/react";
import type { EditorMode } from "../../shared/editor";
import { keymap } from "../keymap";

/** Edit tools, then review tools; a separator falls between the groups. */
const groups = [
  [
    { mode: "select", action: "editPointer", icon: Cursor },
    { mode: "trim", action: "editTrim", icon: SplitHorizontal },
    { mode: "blade", action: "editBlade", icon: Knife },
  ],
  [
    { mode: "draw", action: "cutroomDraw", icon: PencilSimple },
    { mode: "comment", action: "cutroomComment", icon: ChatCircle },
  ],
] as const;
type Tool = (typeof groups)[number][number];

const TOOLTIP_DELAY = 400;

/**
 * Icon buttons named by a tooltip. The first tooltip waits, so a pointer passing by shows
 * nothing; once one is up, moving to a neighbour shows the next at once.
 */
export function ToolButtons({
  mode,
  onMode,
}: {
  mode: EditorMode;
  onMode(mode: Tool["mode"]): void;
}) {
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<number>(undefined);
  const [shown, setShown] = useState<{
    tool: Tool;
    left: number;
    top: number;
  } | null>(null);
  useEffect(() => {
    if (shown) tip.current?.showPopover();
    else tip.current?.hidePopover();
  }, [shown]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = (tool: Tool, button: HTMLElement, wait: boolean) => {
    window.clearTimeout(timer.current);
    const place = () => {
      const box = button.getBoundingClientRect();
      setShown({ tool, left: box.left, top: box.bottom + 4 });
    };
    if (wait) timer.current = window.setTimeout(place, TOOLTIP_DELAY);
    else place();
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setShown(null);
  };
  return (
    <div className="edit-tool-group" onPointerLeave={hide}>
      {groups.map((group, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="edit-separator" />}
          {group.map((tool) => (
            <button
              key={tool.mode}
              className="edit-tool"
              aria-label={`${keymap[tool.action].label} ${keymap[tool.action].keys[0]}`}
              aria-pressed={mode === tool.mode}
              onClick={() => onMode(tool.mode)}
              onPointerEnter={(event) =>
                show(tool, event.currentTarget, shown === null)
              }
              onPointerDown={hide}
              onFocus={(event) => {
                if (event.currentTarget.matches(":focus-visible"))
                  show(tool, event.currentTarget, false);
              }}
              onBlur={hide}
            >
              <tool.icon
                size={16}
                weight={mode === tool.mode ? "fill" : "regular"}
              />
            </button>
          ))}
        </Fragment>
      ))}
      {/* The button's own name already says this; the tooltip is for sighted pointer users. */}
      <span
        ref={tip}
        popover="manual"
        aria-hidden="true"
        className="edit-tooltip"
        style={shown ? { left: shown.left, top: shown.top } : undefined}
      >
        {shown && (
          <>
            {keymap[shown.tool.action].label}
            <kbd>{keymap[shown.tool.action].keys[0]}</kbd>
          </>
        )}
      </span>
    </div>
  );
}
