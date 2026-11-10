import { expect, test } from "bun:test";
import { describeTool } from "../src/shared/toolRow";

test("tool calls read as a verb and what it acted on", () => {
  expect(describeTool({ tool: "Edit", target: "index.html" })).toEqual({
    verb: "Edited",
    object: "index.html",
  });
  expect(
    describeTool({ tool: "Read", target: "index.html" }, "active"),
  ).toEqual({ verb: "Reading", object: "index.html" });
  // Claude and Codex name Cutroom's own tools differently; both read the same.
  for (const tool of [
    "mcp__cutroom_studio__source_write",
    "cutroom_studio: source_write",
  ])
    expect(describeTool({ tool, target: "intro.html" })).toEqual({
      verb: "Edited",
      object: "intro.html",
    });
  // source_read defaults to the main composition when no path is passed.
  expect(describeTool({ tool: "mcp__cutroom_studio__source_read" })).toEqual({
    verb: "Read",
    object: "index.html",
  });
  expect(
    describeTool({ tool: "mcp__cutroom_studio__source_write" }, "ask"),
  ).toEqual({ verb: "Write", object: "index.html" });
  expect(describeTool({ tool: "mcp__other__summarize" })).toEqual({
    verb: "Used",
    object: "summarize",
  });
});
