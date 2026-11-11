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
