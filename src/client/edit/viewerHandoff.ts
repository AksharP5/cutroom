export interface Picture {
  gen: number;
  revision: number;
  width: number;
  height: number;
  shown: number;
}

interface Candidate {
  gen: number;
  deadline: number;
}

export type Handoff =
  | { kind: "showing"; confirmed: Picture | null }
  | { kind: "loading"; confirmed: Picture | null; candidate: Candidate }
  | {
      kind: "promoting";
      confirmed: Picture | null;
      candidate: Candidate & Picture;
    }
  | { kind: "failed"; confirmed: Picture | null; reason: unknown };

type Event =
  | { type: "navigate"; gen: number; deadline: number }
  | { type: "loaded"; gen: number; deadline: number }
  | { type: "unloaded"; gen: number; deadline: number }
  | { type: "prepared"; picture: Picture }
  | { type: "painted"; gen: number }
  | { type: "failed"; gen: number; reason: unknown }
  | { type: "reported" };

/** Only a confirmed visible paint can replace the picture we retain. Stale work has no effect. */
export function transitionHandoff(state: Handoff, event: Event): Handoff {
  if (event.type === "navigate")
    return {
      kind: "loading",
      confirmed: state.confirmed,
      candidate: { gen: event.gen, deadline: event.deadline },
    };
  // The confirmed document reloading itself (not a new edit) starts its lifecycle again, so
  // the reloaded document is prepared, painted and reattached to the transport like any other.
  if (event.type === "loaded" || event.type === "unloaded") {
    if (state.kind === "promoting" && state.candidate.gen === event.gen)
      return {
        kind: "loading",
        confirmed: state.confirmed,
        candidate: { gen: event.gen, deadline: state.candidate.deadline },
      };
    return state.kind === "showing" && state.confirmed?.gen === event.gen
      ? {
          kind: "loading",
          confirmed: state.confirmed,
          candidate: { gen: event.gen, deadline: event.deadline },
        }
      : state;
  }
  if (event.type === "reported")
    return state.kind === "failed"
      ? { kind: "showing", confirmed: state.confirmed }
      : state;
  if (state.kind !== "loading" && state.kind !== "promoting") return state;
  const gen = event.type === "prepared" ? event.picture.gen : event.gen;
  if (gen !== state.candidate.gen) return state;
  switch (event.type) {
    case "prepared":
      return state.kind === "loading"
        ? {
            ...state,
            kind: "promoting",
            candidate: { ...state.candidate, ...event.picture },
          }
        : state;
    case "painted":
      return state.kind === "promoting"
        ? { kind: "showing", confirmed: state.candidate }
        : state;
    case "failed":
      return {
        kind: "failed",
        confirmed: state.confirmed,
        reason: event.reason,
      };
  }
}
