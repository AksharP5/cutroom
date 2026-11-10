import { expect, test } from "bun:test";
import { describeTool } from "../src/client/toolRow";

test("tool calls read as a verb and what it acted on", () => {
  expect(
    describeTool({ tool: "Edit", target: "index.html", status: "complete" }),
  ).toEqual({ verb: "Edited", object: "index.html" });
  expect(
    describeTool({ tool: "Read", target: "index.html", status: "streaming" }),
  ).toEqual({ verb: "Reading", object: "index.html" });
  // Claude and Codex name the same MCP tool differently.
  for (const tool of ["mcp__cutroom__timeline_read", "cutroom: timeline_read"])
    expect(describeTool({ tool, status: "complete" })).toEqual({
      verb: "Read",
      object: "timeline",
    });
  expect(
    describeTool({ tool: "mcp__other__summarize", status: "failed" }),
  ).toEqual({ verb: "Used", object: "summarize" });
});
