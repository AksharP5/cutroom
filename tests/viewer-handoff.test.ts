import { expect, test } from "bun:test";
import { transitionHandoff } from "../src/client/edit/viewerHandoff";
import type { Handoff } from "../src/client/edit/viewerHandoff";

const confirmed = { gen: 1, revision: 1, width: 640, height: 360, shown: 101 };
const showing: Handoff = { kind: "showing", confirmed };

test("a superseded promotion cannot confirm or fail the newer candidate", () => {
  const loading = transitionHandoff(showing, {
    type: "navigate",
    gen: 2,
    deadline: 15_000,
  });
  const promoting = transitionHandoff(loading, {
    type: "prepared",
    picture: { ...confirmed, gen: 2 },
  });
  const newer = transitionHandoff(promoting, {
    type: "navigate",
    gen: 3,
    deadline: 16_000,
  });
  expect(newer).toEqual({
    kind: "loading",
    confirmed,
    candidate: { gen: 3, deadline: 16_000 },
    retiring: 2,
  });
  expect(transitionHandoff(newer, { type: "painted", gen: 2 })).toBe(newer);
  expect(
    transitionHandoff(newer, {
      type: "failed",
      gen: 2,
      reason: new Error("Late failure"),
    }),
  ).toBe(newer);
  expect(
    transitionHandoff(newer, {
      type: "prepared",
      picture: { ...confirmed, gen: 2 },
    }),
  ).toBe(newer);
});

test("promotion keeps the navigation deadline and failure reports only once without losing the picture", () => {
  const loading = transitionHandoff(showing, {
    type: "navigate",
    gen: 2,
    deadline: 15_000,
  });
  const promoting = transitionHandoff(loading, {
    type: "prepared",
    picture: { ...confirmed, gen: 2 },
  });
  expect(promoting).toMatchObject({
    kind: "promoting",
    candidate: { deadline: 15_000 },
  });
  const failed = transitionHandoff(promoting, {
    type: "failed",
    gen: 2,
    reason: "Deadline",
  });
  expect(failed).toEqual({
    kind: "failed",
    confirmed,
    reason: "Deadline",
    retiring: 2,
  });
  expect(
    transitionHandoff(failed, {
      type: "failed",
      gen: 2,
      reason: "Paint timeout",
    }),
  ).toBe(failed);
  const reported = transitionHandoff(
    transitionHandoff(failed, { type: "reported" }),
    { type: "retired", gen: 2 },
  );
  expect(reported).toEqual(showing);
  expect(transitionHandoff(reported, { type: "painted", gen: 2 })).toBe(
    reported,
  );
});

test("a timed-out handoff keeps its picture for two backoff retries and then reports", () => {
  let state: Handoff = showing;
  const reason = new Error("Deadline");
  for (const [attempt, delay] of [
    [0, 1000],
    [1, 2000],
    [2, null],
  ] as const) {
    const gen = attempt + 2;
    state = transitionHandoff(state, {
      type: "navigate",
      gen,
      deadline: 15_000,
      attempt,
    });
    state = transitionHandoff(state, {
      type: "failed",
      gen,
      reason,
      timedOut: true,
    });
    if (delay !== null) {
      expect(state).toEqual({
        kind: "retrying",
        confirmed,
        retry: { gen, attempt: attempt + 1, delay },
      });
      expect(
        transitionHandoff(state, {
          type: "prepared",
          picture: { ...confirmed, gen },
        }),
      ).toBe(state);
    }
  }
  expect(state).toEqual({ kind: "failed", confirmed, reason });
});

test("a dropped promotion stays mounted, hidden, until the parent has painted without it", () => {
  const promote = (state: Handoff, gen: number) =>
    transitionHandoff(
      transitionHandoff(state, { type: "navigate", gen, deadline: 15_000 }),
      { type: "prepared", picture: { ...confirmed, gen } },
    );
  // The covering candidate is superseded; the next navigation must not unmount it early.
  const superseded = transitionHandoff(promote(showing, 2), {
    type: "navigate",
    gen: 3,
    deadline: 15_000,
  });
  const next = transitionHandoff(superseded, {
    type: "navigate",
    gen: 4,
    deadline: 15_000,
  });
  expect(next).toMatchObject({ candidate: { gen: 4 }, retiring: 2 });
  expect(transitionHandoff(next, { type: "retired", gen: 3 })).toBe(next);
  expect(transitionHandoff(next, { type: "retired", gen: 2 })).toEqual({
    kind: "loading",
    confirmed,
    candidate: { gen: 4, deadline: 15_000 },
  });
  // Confirmation and a candidate's own reload keep it; neither drops a covering document.
  const promoting = promote(showing, 2);
  expect(
    transitionHandoff(promoting, { type: "painted", gen: 2 }),
  ).not.toHaveProperty("retiring");
  expect(
    transitionHandoff(promoting, {
      type: "unloaded",
      gen: 2,
      deadline: 20_000,
    }),
  ).not.toHaveProperty("retiring");
});

test("a reload of the confirmed document is prepared and painted again; other loads change nothing", () => {
  const reloading = transitionHandoff(showing, {
    type: "loaded",
    gen: 1,
    deadline: 15_000,
  });
  expect(reloading).toEqual({
    kind: "loading",
    confirmed,
    candidate: { gen: 1, deadline: 15_000 },
  });
  const reloaded = { ...confirmed, shown: 102 };
  const promoting = transitionHandoff(reloading, {
    type: "prepared",
    picture: reloaded,
  });
  expect(
    transitionHandoff(promoting, { type: "painted", gen: 1 }),
  ).toMatchObject({ kind: "showing", confirmed: reloaded });
  // A candidate's own first load is already loading; it keeps its deadline.
  const loading = transitionHandoff(showing, {
    type: "navigate",
    gen: 2,
    deadline: 15_000,
  });
  expect(
    transitionHandoff(loading, { type: "loaded", gen: 2, deadline: 20_000 }),
  ).toBe(loading);
});

test("document teardown starts the reload deadline before load and stale teardown cannot restart a handoff", () => {
  const reloading = transitionHandoff(showing, {
    type: "unloaded",
    gen: 1,
    deadline: 15_000,
  });
  expect(reloading).toMatchObject({
    kind: "loading",
    candidate: { gen: 1, deadline: 15_000 },
  });
  expect(
    transitionHandoff(reloading, { type: "loaded", gen: 1, deadline: 20_000 }),
  ).toBe(reloading);
  const navigating = transitionHandoff(showing, {
    type: "navigate",
    gen: 2,
    deadline: 15_000,
  });
  expect(
    transitionHandoff(navigating, {
      type: "unloaded",
      gen: 1,
      deadline: 20_000,
    }),
  ).toBe(navigating);
});

test("a document reloading during promotion must prepare again within its original deadline", () => {
  const loading = transitionHandoff(showing, {
    type: "navigate",
    gen: 2,
    deadline: 15_000,
  });
  const promoting = transitionHandoff(loading, {
    type: "prepared",
    picture: { ...confirmed, gen: 2 },
  });
  const reloading = transitionHandoff(promoting, {
    type: "unloaded",
    gen: 2,
    deadline: 20_000,
  });
  expect(reloading).toEqual(loading);
  expect(transitionHandoff(reloading, { type: "painted", gen: 2 })).toBe(
    reloading,
  );
  expect(
    transitionHandoff(reloading, {
      type: "prepared",
      picture: { ...confirmed, gen: 2 },
    }).kind,
  ).toBe("promoting");
});

test("a live acknowledgment advances only its confirmed document, never a newer reload or revision", () => {
  const updated = transitionHandoff(showing, {
    type: "updated",
    gen: 1,
    revision: 3,
  });
  expect(updated).toMatchObject({
    kind: "showing",
    confirmed: { ...confirmed, revision: 3 },
  });
  expect(
    transitionHandoff(updated, { type: "updated", gen: 1, revision: 2 }),
  ).toBe(updated);
  const loading = transitionHandoff(updated, {
    type: "navigate",
    gen: 2,
    deadline: 15000,
  });
  expect(
    transitionHandoff(loading, { type: "updated", gen: 1, revision: 4 }),
  ).toBe(loading);
});

test("gain checks retain the playing picture and only their latest revision may finish", () => {
  const checking = transitionHandoff(showing, {
    type: "check",
    revision: 2,
    deadline: 15_000,
  });
  expect(checking).toEqual({
    kind: "checking",
    confirmed,
    check: { revision: 2, deadline: 15_000 },
  });
  const newer = transitionHandoff(checking, {
    type: "check",
    revision: 3,
    deadline: 16_000,
  });
  expect(transitionHandoff(newer, { type: "mixed", revision: 2 })).toBe(newer);
  expect(
    transitionHandoff(newer, {
      type: "check-failed",
      revision: 2,
      reason: "Late failure",
    }),
  ).toBe(newer);
  expect(
    transitionHandoff(newer, { type: "updated", gen: 1, revision: 2 }),
  ).toBe(newer);
  expect(
    transitionHandoff(newer, { type: "updated", gen: 1, revision: 3 }),
  ).toEqual({
    kind: "showing",
    confirmed: { ...confirmed, revision: 3 },
  });
  const mixed = transitionHandoff(newer, { type: "mixed", revision: 3 });
  expect(mixed).toEqual(showing);
  // The existing player must not reattach just because its gain changed.
  expect(mixed.confirmed).toBe(confirmed);
  const navigating = transitionHandoff(newer, {
    type: "navigate",
    gen: 2,
    deadline: 16_000,
  });
  expect(transitionHandoff(navigating, { type: "mixed", revision: 3 })).toBe(
    navigating,
  );
});

test("a failed gain check reports once while preserving the existing document", () => {
  const checking = transitionHandoff(showing, {
    type: "check",
    revision: 2,
    deadline: 15_000,
  });
  const failed = transitionHandoff(checking, {
    type: "check-failed",
    revision: 2,
    reason: "Deadline",
  });
  expect(failed).toEqual({ kind: "failed", confirmed, reason: "Deadline" });
  expect(
    transitionHandoff(failed, {
      type: "check-failed",
      revision: 2,
      reason: "Late reply",
    }),
  ).toBe(failed);
  expect(transitionHandoff(failed, { type: "reported" })).toEqual(showing);
});

test("a document reloading during its gain check keeps the overall deadline", () => {
  const checking = transitionHandoff(showing, {
    type: "check",
    revision: 2,
    deadline: 15_000,
  });
  const reloading = transitionHandoff(checking, {
    type: "unloaded",
    gen: 1,
    deadline: 20_000,
  });
  expect(reloading).toEqual({
    kind: "loading",
    confirmed,
    candidate: { gen: 1, deadline: 15_000 },
  });
  expect(
    transitionHandoff(reloading, {
      type: "check-failed",
      revision: 2,
      reason: "Disposed connection",
    }),
  ).toBe(reloading);
});
