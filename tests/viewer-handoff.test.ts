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
  expect(failed).toEqual({ kind: "failed", confirmed, reason: "Deadline" });
  expect(
    transitionHandoff(failed, {
      type: "failed",
      gen: 2,
      reason: "Paint timeout",
    }),
  ).toBe(failed);
  const reported = transitionHandoff(failed, { type: "reported" });
  expect(reported).toEqual(showing);
  expect(transitionHandoff(reported, { type: "painted", gen: 2 })).toBe(
    reported,
  );
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
