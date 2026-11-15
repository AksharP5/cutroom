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

export type Handoff = (
  | { kind: "showing"; confirmed: Picture | null }
  | {
      kind: "checking";
      confirmed: Picture;
      check: { revision: number; deadline: number };
    }
  | { kind: "loading"; confirmed: Picture | null; candidate: Candidate }
  | {
      kind: "promoting";
      confirmed: Picture | null;
      candidate: Candidate & Picture;
    }
  | { kind: "failed"; confirmed: Picture | null; reason: unknown }
) & {
  /**
   * A promoted candidate dropped while it still covered the picture. Removing that iframe in
   * the same commit can composite a frame of bare composition background where it was. It
   * stays mounted, hidden, until the parent has painted without it.
   */
  retiring?: number;
};

type Event =
  | { type: "check"; revision: number; deadline: number }
  | { type: "mixed"; revision: number }
  | { type: "check-failed"; revision: number; reason: unknown }
  | { type: "navigate"; gen: number; deadline: number }
  | { type: "loaded"; gen: number; deadline: number }
  | { type: "unloaded"; gen: number; deadline: number }
  | { type: "prepared"; picture: Picture }
  | { type: "painted"; gen: number }
  | { type: "failed"; gen: number; reason: unknown }
  | { type: "updated"; gen: number; revision: number }
  | { type: "reported" }
  | { type: "retired"; gen: number };

/** Only a confirmed visible paint can replace the picture we retain. Stale work has no effect. */
export function transitionHandoff(state: Handoff, event: Event): Handoff {
  if (event.type === "retired") {
    if (state.retiring !== event.gen) return state;
    const next = { ...state };
    delete next.retiring;
    return next;
  }
  const next = advance(state, event);
  if (next === state) return state;
  const dropped =
    state.kind === "promoting" &&
    next.confirmed?.gen !== state.candidate.gen &&
    !(
      (next.kind === "loading" || next.kind === "promoting") &&
      next.candidate.gen === state.candidate.gen
    );
  const retiring = dropped ? state.candidate.gen : state.retiring;
  return retiring === undefined || next.retiring === retiring
    ? next
    : { ...next, retiring };
}

function advance(
  state: Handoff,
  event: Exclude<Event, { type: "retired" }>,
): Handoff {
  if (event.type === "updated")
    return (state.kind === "showing" ||
      (state.kind === "checking" && state.check.revision === event.revision)) &&
      state.confirmed?.gen === event.gen &&
      event.revision > state.confirmed.revision
      ? {
          kind: "showing",
          confirmed: { ...state.confirmed, revision: event.revision },
        }
      : state;
  if (event.type === "check")
    return state.kind !== "loading" &&
      state.kind !== "promoting" &&
      state.confirmed
      ? {
          kind: "checking",
          confirmed: state.confirmed,
          check: { revision: event.revision, deadline: event.deadline },
        }
      : state;
  if (event.type === "mixed" || event.type === "check-failed") {
    if (state.kind !== "checking" || state.check.revision !== event.revision)
      return state;
    return event.type === "mixed"
      ? { kind: "showing", confirmed: state.confirmed }
      : { kind: "failed", confirmed: state.confirmed, reason: event.reason };
  }
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
    return (state.kind === "showing" || state.kind === "checking") &&
      state.confirmed?.gen === event.gen
      ? {
          kind: "loading",
          confirmed: state.confirmed,
          candidate: {
            gen: event.gen,
            deadline:
              state.kind === "checking" ? state.check.deadline : event.deadline,
          },
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
