import { useEffect, useRef, useState } from "react";
import { audioGainToText, MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import type { Track } from "../../shared/timeline/schema";
import { parseGain } from "../edit/inspector/fields";
import { showToast } from "../workspace";
import { Modal } from "../components/Modal";
import { gainFromDrag } from "./mix";
import type { GainDrag } from "./mix";

/** A press that travels less than this is a click, as on the lanes. */
const DRAG_THRESHOLD = 3;
function trackGain(text: string) {
  const next = parseGain(text);
  if (next > MAX_AUDIO_GAIN)
    throw new Error("Track gain goes up to +12 dB per track stage.");
  return next;
}

const level = (volume: number) => audioGainToText(volume).replace(" dB", "");

/**
 * A track's gain in its header, on top of each clip's own. A drag reads the scale of the gain
 * line on the track's clips, so the same travel changes both by the same amount, and writes once
 * on release. Nothing here runs between pointer events.
 */
export function TrackGain({
  track,
  id,
  body,
  onCommit,
  onGesture,
}: {
  track: Track;
  id: string;
  /** Height of a clip body on this track, which the drag scale is read from. */
  body: number;
  onCommit(volume: number): void;
  onGesture(active: boolean): void;
}) {
  const [shown, setShown] = useState<number | null>(null);
  const [typing, setTyping] = useState(false);
  const drag = useRef<
    | (GainDrag & {
        y: number;
        next: number;
        moved: boolean;
        release(): void;
      })
    | null
  >(null);
  const end = () => {
    const held = drag.current;
    if (!held) return null;
    drag.current = null;
    held.release();
    setShown(null);
    return held;
  };
  useEffect(() => () => void end(), []);
  const volume = shown ?? track.volume;

  if (typing)
    return (
      <input
        className="tl-track-gain"
        aria-label={`Gain ${id} in dB`}
        autoFocus
        spellCheck={false}
        defaultValue={level(track.volume)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setTyping(false)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          if (event.key === "Enter")
            try {
              const next = trackGain(event.currentTarget.value);
              if (next !== track.volume) onCommit(next);
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error));
            }
          setTyping(false);
        }}
      />
    );
  return (
    <button
      className="tl-track-gain"
      aria-label={`Gain ${id}`}
      data-unity={volume === 1 ? "" : undefined}
      title={`Track gain ${audioGainToText(volume)}, independent of clip gain, up to +12 dB per track stage. Drag up or down, Shift for fine adjustment. Double-click to type. Alt-click resets to 0 dB.`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        // Esc during a drag cancels it, before the editor sees the key.
        const cancel = (key: KeyboardEvent) => {
          if (key.key !== "Escape") return;
          key.preventDefault();
          key.stopImmediatePropagation();
          end();
        };
        window.addEventListener("keydown", cancel, true);
        drag.current = {
          y: event.clientY,
          from: track.volume,
          next: track.volume,
          moved: false,
          dy: 0,
          fine: event.shiftKey,
          body,
          lane: 1,
          fade: 1,
          release() {
            window.removeEventListener("keydown", cancel, true);
            if (this.moved) onGesture(false);
          },
        };
      }}
      onPointerMove={(event) => {
        const held = drag.current;
        if (!held) return;
        const dy = event.clientY - held.y;
        if (!held.moved && Math.abs(dy) < DRAG_THRESHOLD) return;
        if (!held.moved) onGesture(true);
        held.moved = true;
        // Shift changed: the drag carries on from the gain shown, without a jump.
        if (held.fine !== event.shiftKey) {
          held.from = held.next;
          held.y = event.clientY;
          held.fine = event.shiftKey;
        }
        held.dy = event.clientY - held.y;
        held.next = gainFromDrag(held);
        setShown(held.next);
      }}
      onPointerUp={(event) => {
        const held = end();
        if (!held) return;
        if (held.moved) {
          if (held.next !== track.volume) onCommit(held.next);
        } else if (event.altKey && track.volume !== 1) onCommit(1);
      }}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => setTyping(true)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== "F2") return;
        event.preventDefault();
        event.stopPropagation();
        setTyping(true);
      }}
    >
      {level(volume)}
    </button>
  );
}

/** The same gain entry remains available when compact headers hide the number. */
export function TrackGainDialog({
  track,
  onCommit,
  onClose,
}: {
  track: Track;
  onCommit(volume: number): void;
  onClose(): void;
}) {
  const [text, setText] = useState(level(track.volume));
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  return (
    <Modal
      title={`Set ${track.name ?? "track"} gain`}
      onClose={onClose}
      initialFocus={input}
    >
      <form
        className="project-form"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const volume = trackGain(text);
            if (volume !== track.volume) onCommit(volume);
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        <label>
          Gain in dB
          <input
            ref={input}
            aria-label="Track gain in dB"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <p className="field-help">
          Up to +12 dB per track stage. Type -inf for silence.
        </p>
        {error && <p role="alert">{error}</p>}
        <footer className="modal-actions">
          <button type="submit">Set gain</button>
        </footer>
      </form>
    </Modal>
  );
}
