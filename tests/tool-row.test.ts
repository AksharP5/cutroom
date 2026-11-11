import { expect, test } from "bun:test";
import type { AgentMessage } from "../src/shared/agent";
import {
  describeTool,
  failureReason,
  summarizeSteps,
} from "../src/shared/toolRow";

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

test("a Cutroom edit names its clips or note, and another server's tool never borrows that wording", () => {
  expect(
    describeTool({
      tool: "mcp__cutroom_studio__timeline_edit",
      target: "Lower third and Kicker",
    }),
  ).toEqual({ verb: "Edited", object: "Lower third and Kicker" });
  expect(describeTool({ tool: "cutroom_studio: timeline_edit" })).toEqual({
    verb: "Edited",
    object: "the timeline",
  });
  expect(
    describeTool(
      { tool: "cutroom_studio: review_claim", target: "“Tighten the intro”" },
      "active",
    ),
  ).toEqual({ verb: "Starting", object: "“Tighten the intro”" });
  expect(describeTool({ tool: "mcp__other__timeline_edit" })).toEqual({
    verb: "Edited",
    object: "timeline",
  });
});

let next = 0;
const step = (
  tool: string,
  status: AgentMessage["status"] = "complete",
  text = "",
): AgentMessage => ({
  id: `step-${next++}`,
  role: "tool",
  tool,
  text,
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
});
const cutroom = (name: string) => `mcp__cutroom_studio__${name}`;

test("routine steps fold into counts while failures and project edits keep their rows", () => {
  const failed = step("Bash", "failed", "Exit code 1\nnpm error missing");
  const edit = step(cutroom("timeline_edit"));
  const steps = [
    step(cutroom("review_list")),
    step(cutroom("review_claim")),
    ...Array.from({ length: 6 }, () => step("Read")),
    step("Bash"),
    failed,
    step("Bash"),
    edit,
    ...Array.from({ length: 3 }, () => step(cutroom("timeline_view"))),
    step(cutroom("review_complete")),
  ];
  // The work is named first; lookups and queue updates around it are only counted.
  expect(summarizeSteps(steps)).toEqual({
    summary: "Read 6 files, ran 2 commands, 6 more",
    running: false,
    shown: [failed, edit],
  });
  expect(summarizeSteps([step("Read"), step("Read")]).summary).toBe(
    "Read 2 files",
  );
  expect(
    summarizeSteps([step("Grep"), step("Glob"), step("WebFetch")]).summary,
  ).toBe("Searched 2 times, browsed the web");
});

test("a summary counts the running step in the present tense, and one routine step stays a row", () => {
  const reading = step("Read", "streaming");
  expect(summarizeSteps([step("Read"), step("Bash"), reading])).toMatchObject({
    summary: "Reading 2 files, ran 1 command",
    running: true,
    shown: [],
  });
  const lone = [step("Read"), step("Edit")];
  expect(summarizeSteps(lone)).toEqual({
    summary: "",
    running: false,
    shown: lone,
  });
});

test("a failed call says why on one line", () => {
  // Claude leads a failed command with its exit code.
  expect(
    failureReason({
      tool: "Bash",
      text: "Exit code 1\nnpm error could not determine executable to run\nnpm error A complete log is in /home/me/.npm/_logs",
    }),
  ).toBe("npm error could not determine executable to run");
  // Codex leads a command's output with the command itself.
  expect(
    failureReason({
      tool: "Shell",
      text: "/usr/bin/bash -lc 'cat missing.txt'\ncat: missing.txt: No such file or directory",
    }),
  ).toBe("cat: missing.txt: No such file or directory");
  // MCP results arrive as content blocks, and Cutroom's API explains a refusal in JSON.
  expect(
    failureReason({
      tool: "mcp__cutroom_studio__timeline_edit",
      text: JSON.stringify([
        {
          type: "text",
          text: 'Cutroom returned 409: {"error":"The timeline changed since it was read. Read it again before editing."}',
        },
      ]),
    }),
  ).toBe(
    "The timeline changed since it was read. Read it again before editing.",
  );
  expect(
    failureReason({
      tool: "cutroom_studio: timeline_edit",
      text: JSON.stringify({
        content: [{ type: "text", text: "Cutroom returned 500: boom" }],
        isError: true,
      }),
    }),
  ).toBe("Cutroom returned 500: boom");
  expect(failureReason({ tool: "Read", text: "" })).toBe("");
});
