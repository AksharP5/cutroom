import { useEffect, useRef, useState } from "react";
import { showsAt } from "./notes";
import { useTransport } from "./transport";

type TimedNote = { id: string; frame: number; end: number | null };

/** Playback holds a crossed note for a second, then gives its pin and ink the same 200ms fade. */
export class NoteVisibility {
  private entered = new Map<string, { start: number; left: number | null }>();
  private previous: number | null = null;

  update(
    notes: readonly TimedNote[],
    frame: number,
    playing: boolean,
    now: number,
  ) {
    const shown = new Map<string, "shown" | "fading">();
    if (!playing) this.entered.clear();
    for (const note of notes) {
      const exact = showsAt(note, frame);
      const crossed =
        playing &&
        this.previous !== null &&
        ((this.previous < note.frame && frame > note.frame) ||
          (this.previous > (note.end ?? note.frame) &&
            frame < (note.end ?? note.frame)));
      if (!playing) {
        if (exact) shown.set(note.id, "shown");
        continue;
      }
      let entered = this.entered.get(note.id);
      if ((exact || crossed) && (!entered || entered.left !== null)) {
        entered = { start: now, left: null };
        this.entered.set(note.id, entered);
      }
      if (!entered) continue;
      if (!exact) entered.left ??= now;
      const fadeAt = Math.max(entered.start + 1000, entered.left ?? now);
      if (exact || now < fadeAt) shown.set(note.id, "shown");
      else if (now < fadeAt + 200) shown.set(note.id, "fading");
      else this.entered.delete(note.id);
    }
    this.previous = frame;
    return shown;
  }
}

export function useNoteVisibility(notes: readonly TimedNote[]) {
  const latest = useRef(notes);
  latest.current = notes;
  const visibility = useRef(new NoteVisibility());
  const [shown, setShown] = useState(new Map<string, "shown" | "fading">());
  const update = () => {
    const { frame, state } = useTransport.getState();
    const next = visibility.current.update(
      latest.current,
      frame,
      state.kind === "playing" || state.kind === "shuttle",
      performance.now(),
    );
    setShown((previous) =>
      previous.size === next.size &&
      [...next].every(([id, phase]) => previous.get(id) === phase)
        ? previous
        : next,
    );
  };
  const refresh = useRef(update);
  refresh.current = update;
  useEffect(() => useTransport.subscribe(() => refresh.current()), []);
  useEffect(() => refresh.current());
  return shown;
}
